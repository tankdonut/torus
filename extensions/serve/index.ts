/**
 * torus serve — authenticated HTTP surface over roster delegations.
 *
 * Booted only by the `torus serve` launcher subcommand (runtime/bin/torus.mjs
 * intercepts it before the pi passthrough); this module never starts on
 * import and is not a pi manifest extension. TORUS_SERVE=0 is a kill switch:
 * startServe refuses, the launcher exits 1.
 *
 * Every POST /run fires a real session-free delegation — runDelegation with
 * parentSession null, the same production path memory reflect/dream and team
 * respawn use — so runs land in the shared registry (record + run beacon)
 * and are fleet-visible like any other delegation. Each request tags its run
 * with a unique `srv-` handle: that is how the server maps a response to its
 * registry record before the run's outcome exists, and it reads as a label
 * in fleet views.
 *
 * TRUST BOUNDARY: delegations inherit this process's environment — provider
 * credentials included — so the bearer token is the entire boundary. Anyone
 * holding it can spend the account's models; keep auth.json owner-only (it
 * is minted 0600). Only /health is unauthenticated; every other route
 * requires a constant-time bearer-token match.
 *
 * Scheduled triggers: serve.json `triggers: [{name, everyMinutes, agent,
 * task, model?}]` entries each run one unref'd setInterval that fires the
 * same roster pre-flight path as POST /run. An invalid entry refuses
 * startup (fail loud, fix the file) naming the trigger and field; a missing
 * or empty array schedules nothing. A tick skips while that trigger's own
 * previous run is still active, and lastFired persists to
 * ~/.torus/serve/triggers-state.json so a restart within the interval never
 * re-fires.
 *
 * Webhook triggers: a trigger with a `webhook: {path}` block also answers
 * POST at that path. Auth is a per-trigger secret (X-Torus-Secret,
 * timing-safe) minted like the bearer token, persisted in
 * triggers-state.json, and printed once at first start. The JSON body is
 * DATA: {{payload.<field>}} values render JSON-stringified (depth-capped)
 * into the task, and every request fires a fresh delegation — webhooks are
 * explicit events, so the scheduler's skip-while-active gate deliberately
 * does not apply. Responses are fire-and-ack: {delegationId} immediately.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import {
	createServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { readJson, sleep, torusHome, writeJson } from "../fsutil.js";
import { AGENT_NAME_RE, type DelegationRecord, listDelegations, repoRoot } from "../registry.js";
import { AGENTS, type DelegationOutcome, runDelegation } from "../roster/index.js";

export interface ServeConfig {
	port: number;
	bind: string;
	/** Explicit auth-token file; default ~/.torus/serve/auth.json. */
	tokenPath?: string;
	/** Raw `triggers` array — validated by validateTriggers at startup. */
	triggers?: unknown;
}

export interface ServeTrigger {
	name: string;
	everyMinutes: number;
	agent: string;
	task: string;
	model?: string;
	/** Optional webhook endpoint: POST <path> with X-Torus-Secret fires this trigger. */
	webhook?: { path: string };
}

/** Caps for serve.json triggers — max count and floor on the interval. */
export const MAX_TRIGGERS = 8;
export const MIN_EVERY_MINUTES = 5;
/** Webhook paths must sit under /hook/ with a slug remainder (a-z, 0-9, -). */
const WEBHOOK_PATH_RE = /^\/hook\/[a-z0-9-]+$/;
/** Webhook body cap — bigger requests drain, then answer 413. */
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** Payload nesting rendered into a task; deeper values become "[truncated]". */
const PAYLOAD_DEPTH_CAP = 8;

const DEFAULT_CONFIG: ServeConfig = { port: 4747, bind: "127.0.0.1" };

/** House read-with-fallback: missing or malformed serve.json yields defaults. */
export function loadServeConfig(): ServeConfig {
	const file = readJson<Partial<ServeConfig>>(serveConfigPath(), {});
	return {
		port: typeof file.port === "number" && file.port >= 0 ? file.port : DEFAULT_CONFIG.port,
		bind: typeof file.bind === "string" && file.bind.length > 0 ? file.bind : DEFAULT_CONFIG.bind,
		tokenPath: typeof file.tokenPath === "string" ? file.tokenPath : undefined,
		triggers: file.triggers,
	};
}

export function serveConfigPath(): string {
	return path.join(torusHome(), "serve.json");
}

export function defaultAuthPath(): string {
	return path.join(torusHome(), "serve", "auth.json");
}

/** Restart-survivable trigger state, beside auth.json. */
export function triggersStatePath(): string {
	return path.join(torusHome(), "serve", "triggers-state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delegatableAgentNames(): string[] {
	return AGENTS.filter((a) => a.mode !== "session").map((a) => a.name);
}

/** Milliseconds between ticks for a trigger — minutes × 60_000. */
export function triggerIntervalMs(trigger: Pick<ServeTrigger, "everyMinutes">): number {
	return trigger.everyMinutes * 60_000;
}

/**
 * Validate the raw serve.json `triggers` value. Absent/null/[] schedules
 * nothing; anything else must be a well-formed array or startup refuses —
 * the error names the trigger and the offending field so the file can be
 * fixed in one pass.
 */
export function validateTriggers(raw: unknown): { triggers: ServeTrigger[]; error: string | null } {
	if (raw === undefined || raw === null) return { triggers: [], error: null };
	if (!Array.isArray(raw)) {
		return { triggers: [], error: 'serve.json "triggers" must be an array of trigger objects' };
	}
	if (raw.length > MAX_TRIGGERS) {
		return {
			triggers: [],
			error: `serve.json "triggers" lists ${raw.length} entries — the maximum is ${MAX_TRIGGERS}`,
		};
	}
	const agentNames = delegatableAgentNames();
	const seen = new Set<string>();
	const seenWebhookPaths = new Map<string, string>();
	const triggers: ServeTrigger[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const entry = raw[i];
		if (!isRecord(entry)) {
			return { triggers: [], error: `serve.json trigger [${i}] must be an object` };
		}
		const name = entry.name;
		if (typeof name !== "string" || !AGENT_NAME_RE.test(name)) {
			return {
				triggers: [],
				error: `serve.json trigger [${i}]: "name" must be a slug matching ${AGENT_NAME_RE} (got ${JSON.stringify(name)})`,
			};
		}
		if (seen.has(name)) {
			return {
				triggers: [],
				error: `serve.json trigger "${name}": duplicate name — trigger names must be unique`,
			};
		}
		const everyMinutes = entry.everyMinutes;
		if (
			typeof everyMinutes !== "number" ||
			!Number.isInteger(everyMinutes) ||
			everyMinutes < MIN_EVERY_MINUTES
		) {
			return {
				triggers: [],
				error: `serve.json trigger "${name}": "everyMinutes" must be an integer ≥ ${MIN_EVERY_MINUTES} (got ${JSON.stringify(everyMinutes)})`,
			};
		}
		const agent = entry.agent;
		if (typeof agent !== "string" || agent.length === 0) {
			return {
				triggers: [],
				error: `serve.json trigger "${name}": "agent" must be a non-empty string`,
			};
		}
		if (!agentNames.includes(agent)) {
			return {
				triggers: [],
				error: `serve.json trigger "${name}": unknown agent "${agent}" — must be a delegatable roster agent (${agentNames.join(", ")})`,
			};
		}
		const task = entry.task;
		if (typeof task !== "string" || task.length === 0) {
			return {
				triggers: [],
				error: `serve.json trigger "${name}": "task" must be a non-empty string`,
			};
		}
		const model = entry.model;
		if (model !== undefined && typeof model !== "string") {
			return {
				triggers: [],
				error: `serve.json trigger "${name}": "model" must be a string`,
			};
		}
		const webhook = entry.webhook;
		if (webhook !== undefined) {
			if (!isRecord(webhook)) {
				return {
					triggers: [],
					error: `serve.json trigger "${name}": "webhook" must be an object`,
				};
			}
			const hookPath = webhook.path;
			if (typeof hookPath !== "string" || !WEBHOOK_PATH_RE.test(hookPath)) {
				return {
					triggers: [],
					error: `serve.json trigger "${name}": "webhook.path" must start with "/hook/" followed by a slug of lowercase letters, digits, and hyphens (got ${JSON.stringify(hookPath)})`,
				};
			}
			const hookOwner = seenWebhookPaths.get(hookPath);
			if (hookOwner !== undefined) {
				return {
					triggers: [],
					error: `serve.json trigger "${name}": webhook path "${hookPath}" is already used by trigger "${hookOwner}" — webhook paths must be unique`,
				};
			}
			seenWebhookPaths.set(hookPath, name);
		}
		seen.add(name);
		triggers.push({
			name,
			everyMinutes,
			agent,
			task,
			model: typeof model === "string" && model.length > 0 ? model : undefined,
			webhook: isRecord(webhook) ? { path: webhook.path as string } : undefined,
		});
	}
	return { triggers, error: null };
}

interface AuthFile {
	token: string;
	createdAt: string;
}

/**
 * Mint-or-read the bearer token. First start generates 32 random bytes (hex),
 * writes {token, createdAt} 0600, and the caller prints it once; later starts
 * read silently.
 */
function loadOrMintToken(file: string): { token: string; created: boolean } {
	const existing = readJson<AuthFile | null>(file, null);
	if (existing && typeof existing.token === "string" && existing.token.length > 0) {
		return { token: existing.token, created: false };
	}
	const token = randomBytes(32).toString("hex");
	writeJson(file, { token, createdAt: new Date().toISOString() });
	chmodSync(file, 0o600);
	return { token, created: true };
}

interface WebhookSecretState {
	lastFired?: unknown;
	webhookSecret?: unknown;
}

/**
 * Mint-or-read per-trigger webhook secrets — the same lifecycle as the bearer
 * token: first start generates 32 random bytes (hex) per webhook trigger and
 * the caller prints them once; later starts read silently. Secrets live in
 * triggers-state.json (existing lastFired entries preserved) so restarts
 * keep them.
 */
function loadOrMintWebhookSecrets(triggers: ServeTrigger[]): {
	secrets: Record<string, string>;
	created: { name: string; secret: string }[];
} {
	const webhookTriggers = triggers.filter((t) => t.webhook !== undefined);
	if (webhookTriggers.length === 0) return { secrets: {}, created: [] };
	const state = readJson<Record<string, WebhookSecretState>>(triggersStatePath(), {});
	const secrets: Record<string, string> = {};
	const created: { name: string; secret: string }[] = [];
	let changed = false;
	for (const trigger of webhookTriggers) {
		const existing = state[trigger.name]?.webhookSecret;
		if (typeof existing === "string" && existing.length > 0) {
			secrets[trigger.name] = existing;
			continue;
		}
		const secret = randomBytes(32).toString("hex");
		secrets[trigger.name] = secret;
		created.push({ name: trigger.name, secret });
		state[trigger.name] = { ...state[trigger.name], webhookSecret: secret };
		changed = true;
	}
	if (changed) writeJson(triggersStatePath(), state);
	return { secrets, created };
}

/** Constant-time bearer comparison (length-hiding via sha256 digests). */
function tokenMatches(provided: string, expected: string): boolean {
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, token: string): boolean {
	const header = req.headers.authorization ?? "";
	if (!header.startsWith("Bearer ")) return false;
	return tokenMatches(header.slice("Bearer ".length), token);
}

/** Match `{{payload.<field>}}` references — dotted paths traverse objects. */
const PAYLOAD_FIELD_RE = /\{\{payload\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\}\}/g;

/**
 * Render a trigger task against a webhook body. Referenced values render
 * JSON-stringified — 42, "quoted", {"nested":true} — so a payload is always
 * data with its type visible, never merged into the task as bare prose.
 * Values nested deeper than PAYLOAD_DEPTH_CAP levels render "[truncated]";
 * missing fields render empty.
 */
export function renderTaskTemplate(task: string, payload: Record<string, unknown>): string {
	return task.replace(PAYLOAD_FIELD_RE, (_match, fieldPath: string) => {
		let current: unknown = payload;
		for (const segment of fieldPath.split(".")) {
			if (typeof current !== "object" || current === null || Array.isArray(current)) return "";
			current = (current as Record<string, unknown>)[segment];
			if (current === undefined) return "";
		}
		return stringifyCapped(current, 1);
	});
}

function stringifyCapped(value: unknown, depth: number): string {
	if (depth > PAYLOAD_DEPTH_CAP) return '"[truncated]"';
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const items = value.map((item) => stringifyCapped(item === undefined ? null : item, depth + 1));
		return `[${items.join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).filter(
		([, v]) => v !== undefined,
	);
	if (entries.length === 0) return "{}";
	return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stringifyCapped(val, depth + 1)}`).join(",")}}`;
}

/** A registered webhook endpoint: one per trigger with a webhook block. */
interface WebhookRoute {
	path: string;
	trigger: ServeTrigger;
	secret: string;
}

async function handleWebhookRequest(
	req: IncomingMessage,
	res: ServerResponse,
	route: WebhookRoute,
): Promise<void> {
	let payload: Record<string, unknown>;
	try {
		payload = await readJsonObject(req, WEBHOOK_MAX_BODY_BYTES);
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			return sendJson(res, 413, { ok: false, error: "payload-too-large", message: err.message });
		}
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-body",
			message: err instanceof Error ? err.message : String(err),
		});
	}
	// Webhooks are explicit events: unlike a timer tick, every request fires
	// its own delegation — no skip-while-active gate, no lastFired bookkeeping.
	// The task itself is config-owned; only the payload-rendered parts are
	// caller-controlled data.
	const task = renderTaskTemplate(route.trigger.task, payload);
	const fired = fireRun(route.trigger.agent, task, undefined, route.trigger.model ?? null);
	return respondFireAndForget(res, fired);
}

const VERSION =
	readJson<{ version?: string }>(path.join(repoRoot(), "package.json"), {}).version ?? "unknown";

const MAX_BODY_BYTES = 1024 * 1024;
/** How long wait:true rides along a run before answering 504. */
const WAIT_CAP_MS = 10 * 60 * 1000;
/** Polling budget for spotting a fired run's registry record. */
const RUN_ID_DEADLINE_MS = 10_000;
const RUN_ID_POLL_MS = 20;

class BodyError extends Error {}

/** Distinct so webhook routing can answer 413 while /run keeps its 400. */
class BodyTooLargeError extends BodyError {}

/**
 * Unref'd sleep for the wait cap: the losing race branch leaves its timer
 * behind, and a ref'd 10-minute timer would hold the process open long after
 * the winner answered.
 */
function sleepDetached(ms: number): Promise<null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		timer.unref();
	});
}

async function readJsonObject(
	req: IncomingMessage,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	let tooLarge = false;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > maxBytes) {
			// Past the cap: keep draining (bounded by MAX_BODY_BYTES of slack,
			// then the socket dies) so the error response lands cleanly on a
			// keep-alive connection — but never buffer another byte.
			tooLarge = true;
			chunks.length = 0;
			if (size > maxBytes + MAX_BODY_BYTES) req.destroy();
			continue;
		}
		chunks.push(buf);
	}
	if (tooLarge) {
		throw new BodyTooLargeError(`request body exceeds ${Math.round(maxBytes / 1024)} KiB`);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim().length === 0) throw new BodyError("request body must be a JSON object");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new BodyError("request body is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new BodyError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload).toString(),
	});
	res.end(payload);
}

function publicRun(record: DelegationRecord): Record<string, unknown> {
	return {
		delegationId: record.id,
		agent: record.agent,
		model: record.model,
		handle: record.handle,
		status: record.status,
		startedAt: record.startedAt,
		turns: record.turns,
		tokensIn: record.tokensIn,
		tokensOut: record.tokensOut,
		cost: record.cost,
		parentSession: record.parentSession,
	};
}

type GuardedOutcome =
	| { settled: true; outcome: DelegationOutcome }
	| { settled: false; error: unknown };

function guardOutcome(promise: Promise<DelegationOutcome>): Promise<GuardedOutcome> {
	return promise.then(
		(outcome): GuardedOutcome => ({ settled: true, outcome }),
		(error: unknown): GuardedOutcome => ({ settled: false, error }),
	);
}

/** Refusal reason from a pre-flight outcome (no run was started). */
function refusalError(outcome: DelegationOutcome): string {
	const err = outcome.details.error;
	return typeof err === "string" ? err : "delegation-refused";
}

/**
 * Wait until the fired run's registry record exists (it appears before the
 * engine spawn) or its outcome settles — whichever first. Returns the
 * delegation id, or null when the outcome settled with no run (pre-flight
 * refusal, or a crash before the record could be created).
 */
async function awaitRunId(
	handleTag: string,
	guarded: Promise<GuardedOutcome>,
): Promise<string | null> {
	const deadline = Date.now() + RUN_ID_DEADLINE_MS;
	while (Date.now() < deadline) {
		const record = listDelegations().find((r) => r.handle === handleTag);
		if (record) return record.id;
		const settled = await Promise.race([guarded, sleep(RUN_ID_POLL_MS).then(() => null)]);
		if (settled !== null) return settled.settled ? settled.outcome.delegationId : null;
	}
	return null;
}

function fireRun(
	agent: string,
	task: string,
	cwd: string | undefined,
	model: string | null,
): { handleTag: string; guarded: Promise<GuardedOutcome> } {
	const handleTag = `srv-${randomUUID().slice(0, 8)}`;
	// parentSession null: session-free, the production default for background
	// runs. announce/emitResult false: this process has no transcript sender,
	// so markers would be no-ops anyway — a headless server stays deliberate.
	const outcome = runDelegation(
		agent,
		task,
		cwd,
		undefined,
		null,
		handleTag,
		undefined,
		false,
		false,
		{ model },
	);
	return { handleTag, guarded: guardOutcome(outcome) };
}

async function handleRunRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	let body: Record<string, unknown>;
	try {
		body = await readJsonObject(req, MAX_BODY_BYTES);
	} catch (err) {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-body",
			message: err instanceof Error ? err.message : String(err),
		});
	}
	const { agent, task, model, cwd, wait } = body;
	if (typeof agent !== "string" || agent.length === 0) {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-request",
			message: '"agent" must be a non-empty string',
		});
	}
	if (typeof task !== "string" || task.length === 0) {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-request",
			message: '"task" must be a non-empty string',
		});
	}
	if (model !== undefined && typeof model !== "string") {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-request",
			message: '"model" must be a string',
		});
	}
	if (cwd !== undefined && typeof cwd !== "string") {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-request",
			message: '"cwd" must be a string',
		});
	}
	if (wait !== undefined && typeof wait !== "boolean") {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-request",
			message: '"wait" must be a boolean',
		});
	}

	const { handleTag, guarded } = fireRun(
		agent,
		task,
		typeof cwd === "string" ? cwd : undefined,
		typeof model === "string" && model.trim().length > 0 ? model : null,
	);

	if (wait === true) {
		const settled = await Promise.race([guarded, sleepDetached(WAIT_CAP_MS)]);
		if (settled === null) {
			return sendJson(res, 504, { ok: false, error: "wait-timeout", handle: handleTag });
		}
		if (!settled.settled) {
			return sendJson(res, 500, {
				ok: false,
				error: "delegation-crashed",
				message: String(settled.error),
			});
		}
		const outcome = settled.outcome;
		if (outcome.delegationId === null) {
			return sendJson(res, 400, { ok: false, error: refusalError(outcome), text: outcome.text });
		}
		return sendJson(res, 200, {
			ok: outcome.ok,
			text: outcome.text,
			usage: outcome.details.usage ?? null,
			model: outcome.details.model ?? null,
			delegationId: outcome.delegationId,
			...(outcome.ok ? {} : { error: outcome.details.error ?? "run-failed" }),
		});
	}

	return respondFireAndForget(res, { handleTag, guarded });
}

/**
 * Fire-and-ack tail shared by POST /run (default mode) and webhook fires:
 * resolve the run's delegation id (or its refusal) and answer once — the
 * caller never waits for the run itself to finish.
 */
async function respondFireAndForget(
	res: ServerResponse,
	fired: { handleTag: string; guarded: Promise<GuardedOutcome> },
): Promise<void> {
	const delegationId = await awaitRunId(fired.handleTag, fired.guarded);
	if (delegationId !== null) {
		return sendJson(res, 200, { delegationId });
	}
	const settled = await fired.guarded;
	if (!settled.settled) {
		return sendJson(res, 500, {
			ok: false,
			error: "delegation-crashed",
			message: String(settled.error),
		});
	}
	// Outcome settled with no registry record: roster's own pre-flight refused
	// (unknown agent, invalid model, skill problems) — no engine was spawned.
	return sendJson(res, 400, {
		ok: false,
		error: refusalError(settled.outcome),
		text: settled.outcome.text,
	});
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	token: string,
	webhooks: Map<string, WebhookRoute>,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://torus.serve.internal");
	if (url.pathname === "/health") {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return sendJson(res, 404, { ok: false, error: "not-found" });
		}
		return sendJson(res, 200, { ok: true, version: VERSION });
	}
	if (url.pathname === "/run" || url.pathname === "/runs") {
		if (!authorized(req, token)) {
			return sendJson(res, 401, { ok: false, error: "unauthorized" });
		}
		if (url.pathname === "/runs") {
			if (req.method !== "GET") return sendJson(res, 404, { ok: false, error: "not-found" });
			return sendJson(res, 200, { runs: listDelegations().map(publicRun) });
		}
		if (req.method !== "POST") return sendJson(res, 404, { ok: false, error: "not-found" });
		return handleRunRequest(req, res);
	}
	const route = webhooks.get(url.pathname);
	if (route) {
		if (req.method !== "POST") {
			return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
		}
		const provided = req.headers["x-torus-secret"];
		if (typeof provided !== "string" || !tokenMatches(provided, route.secret)) {
			return sendJson(res, 401, { ok: false, error: "unauthorized" });
		}
		return handleWebhookRequest(req, res, route);
	}
	return sendJson(res, 404, { ok: false, error: "not-found" });
}

export interface ServeOptions {
	port?: number;
	bind?: string;
	tokenPath?: string;
}

export interface ServeHandle {
	server: HttpServer;
	port: number;
	bind: string;
	token: string;
	/** The scheduled-trigger runtime; stopped by close(). */
	triggers: TriggerRuntime;
	close: () => Promise<void>;
}

export interface TriggerRuntime {
	/**
	 * Fire one trigger immediately through the same gate a timer tick uses
	 * (skip while that trigger's run is active, skip within the interval of
	 * the persisted lastFired). Returns true when a run was started.
	 */
	fireNow(name: string): boolean;
	/** Clear all intervals; in-flight runs finish on their own. */
	stop(): void;
}

interface TriggerEntry {
	trigger: ServeTrigger;
	timer: NodeJS.Timeout | null;
	inFlight: boolean;
	lastFired: number | null;
	/** Persisted beside lastFired so webhook secrets survive restarts. */
	webhookSecret: string | null;
}

/**
 * Start the scheduler: one unref'd setInterval per trigger. Validation is
 * the config layer's job (startServe → validateTriggers) — this factory
 * trusts its input, which is also what lets tests drive short real
 * intervals. lastFired loads from triggers-state.json so a restart inside
 * the interval does not re-fire, and persists (atomically) after every fire
 * attempt — fire or later refusal alike — so a broken trigger retries on
 * its own cadence, not every tick.
 */
export function startTriggers(
	triggers: ServeTrigger[],
	options: { webhookSecrets?: Record<string, string> } = {},
): TriggerRuntime {
	const state = readJson<Record<string, { lastFired?: unknown; webhookSecret?: unknown }>>(
		triggersStatePath(),
		{},
	);
	const entries: TriggerEntry[] = triggers.map((trigger) => {
		const saved = state[trigger.name]?.lastFired;
		const stateSecret = state[trigger.name]?.webhookSecret;
		const passedSecret = options.webhookSecrets?.[trigger.name];
		return {
			trigger,
			timer: null,
			inFlight: false,
			lastFired: typeof saved === "number" ? saved : null,
			// startServe mints before this point and passes them in; a bare
			// startTriggers caller keeps whatever the state file already held.
			webhookSecret:
				typeof passedSecret === "string"
					? passedSecret
					: typeof stateSecret === "string" && stateSecret.length > 0
						? stateSecret
						: null,
		};
	});
	const persist = () => {
		const out: Record<string, { lastFired?: number; webhookSecret?: string }> = {};
		for (const entry of entries) {
			if (entry.lastFired !== null || entry.webhookSecret !== null) {
				out[entry.trigger.name] = {
					...(entry.lastFired !== null ? { lastFired: entry.lastFired } : {}),
					...(entry.webhookSecret !== null ? { webhookSecret: entry.webhookSecret } : {}),
				};
			}
		}
		writeJson(triggersStatePath(), out);
	};
	const attemptFire = (entry: TriggerEntry): boolean => {
		const now = Date.now();
		if (entry.inFlight) return false;
		if (entry.lastFired !== null && now - entry.lastFired < triggerIntervalMs(entry.trigger)) {
			return false;
		}
		entry.inFlight = true;
		entry.lastFired = now;
		persist();
		const { guarded } = fireRun(
			entry.trigger.agent,
			entry.trigger.task,
			undefined,
			entry.trigger.model ?? null,
		);
		const settle = () => {
			entry.inFlight = false;
		};
		void guarded.then(settle, settle);
		return true;
	};
	for (const entry of entries) {
		const timer = setInterval(() => attemptFire(entry), triggerIntervalMs(entry.trigger));
		timer.unref();
		entry.timer = timer;
	}
	return {
		fireNow: (name: string): boolean => {
			const entry = entries.find((e) => e.trigger.name === name);
			if (!entry) throw new Error(`no trigger named "${name}"`);
			return attemptFire(entry);
		},
		stop: () => {
			for (const entry of entries) {
				if (entry.timer !== null) clearInterval(entry.timer);
				entry.timer = null;
			}
		},
	};
}

/**
 * Start the delegation API server. Resolves once listening; the kill switch
 * (TORUS_SERVE=0) and bind failures reject — EADDRINUSE is rewritten as a
 * clean error naming the port and the serve.json override.
 */
export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
	if (process.env.TORUS_SERVE === "0") {
		throw new Error("torus serve disabled: TORUS_SERVE=0 is set — unset it to allow the server");
	}
	const config = loadServeConfig();
	const { triggers, error: triggerError } = validateTriggers(config.triggers);
	if (triggerError !== null) throw new Error(triggerError);
	const port = options.port ?? config.port;
	const bind = options.bind ?? config.bind;
	const tokenPath = options.tokenPath ?? config.tokenPath ?? defaultAuthPath();
	const { token, created } = loadOrMintToken(tokenPath);
	if (created) {
		process.stdout.write(`serve token: ${token}\n`);
	}
	const webhookSecrets = loadOrMintWebhookSecrets(triggers);
	for (const minted of webhookSecrets.created) {
		process.stdout.write(`webhook secret for ${minted.name}: ${minted.secret}\n`);
	}
	const webhookRoutes = new Map<string, WebhookRoute>();
	for (const trigger of triggers) {
		if (!trigger.webhook) continue;
		const secret = webhookSecrets.secrets[trigger.name];
		if (secret === undefined) continue;
		webhookRoutes.set(trigger.webhook.path, { path: trigger.webhook.path, trigger, secret });
	}

	const server = createServer((req, res) => {
		void handleRequest(req, res, token, webhookRoutes).catch((err: unknown) => {
			if (!res.headersSent) {
				sendJson(res, 500, { ok: false, error: "internal", message: String(err) });
			} else {
				res.end();
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onListenError = (err: Error & { code?: string }) => {
			server.close();
			if (err.code === "EADDRINUSE") {
				reject(
					new Error(
						`port ${port} on ${bind} is already in use — stop the other listener or set "port" in ${serveConfigPath()} to pick another`,
					),
				);
			} else {
				reject(err);
			}
		};
		server.once("error", onListenError);
		server.listen(port, bind, () => {
			server.off("error", onListenError);
			resolve();
		});
	});

	const bound = server.address();
	const boundPort = typeof bound === "object" && bound !== null ? bound.port : port;
	process.stdout.write(`torus serve: listening on http://${bind}:${boundPort}\n`);
	const triggerRuntime = startTriggers(triggers, { webhookSecrets: webhookSecrets.secrets });
	if (triggers.length > 0) {
		process.stdout.write(
			`torus serve: ${triggers.length} trigger${triggers.length === 1 ? "" : "s"} scheduled (${triggers.map((t) => t.name).join(", ")})\n`,
		);
	}
	return {
		server,
		port: boundPort,
		bind,
		token,
		triggers: triggerRuntime,
		close: () =>
			new Promise<void>((resolve) => {
				triggerRuntime.stop();
				// fetch keep-alive sockets would otherwise hold close() open forever
				server.closeIdleConnections();
				server.close(() => resolve());
			}),
	};
}
