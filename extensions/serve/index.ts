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
 * in fleet views. The body may carry `skills: string[]` — resolved through
 * roster's skill-root containment, refusals surface as pre-flight 400s —
 * and GET /runs/:id reads a single run's public record.
 *
 * TRUST BOUNDARY: delegations inherit this process's environment — provider
 * credentials included — so the bearer token is the entire boundary. Anyone
 * holding it can spend the account's models; keep auth.json owner-only (it
 * is minted 0600). Only /health is unauthenticated; every other route
 * requires a constant-time bearer-token match.
 *
 * Scheduled triggers: the config's `serve` section `triggers:
 * [{name, everyMinutes, agent, task, model?}]` entries each run one unref'd
 * setInterval that fires the
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
 * and fence-wrapped through ../untrusted.js into the task, and every request
 * fires a fresh delegation — webhooks are
 * explicit events, so the scheduler's skip-while-active gate deliberately
 * does not apply. Responses are fire-and-ack: {delegationId} immediately.
 *
 * GitHub webhook triggers: a trigger that also carries a
 * `github: {repo, cwd, events, actions?, secret?}` block becomes a
 * GitHub-class endpoint. Auth is HMAC over the RAW body — the bytes are
 * captured before any JSON parse, `crypto.createHmac("sha256", secret)` is
 * compared timing-safely against the sha256= digest in
 * X-Hub-Signature-256, and a missing or wrong signature answers 401
 * without parsing. The secret is the same value the operator configures in
 * the repo's webhook settings: set it explicitly in config, or leave it
 * off and one is minted per trigger (persisted in triggers-state.json,
 * printed once at first start, like the static-secret path). After the
 * signature the request routes on trusted config only: the X-GitHub-Event
 * header must be in `events`, the payload's repository.full_name must
 * equal `repo`, and (when configured) the payload's action must be in
 * `actions` — any mismatch answers 404 named, no spawn. The delegation
 * runs in `cwd`, which is operator config: the payload never chooses the
 * checkout. GitHub-class triggers are event-driven — `everyMinutes` is
 * optional (a present value still ticks the same scheduler), and the
 * github block requires a webhook path to answer at.
 *
 * Driver-class github triggers (`github.driver: "auto"`) skip fireRun:
 * the rendered task becomes the objective of an in-process startAuto
 * stage chain (plan → gate → execute → lens) running in this process with
 * the trigger's cwd as the driven checkout. startAuto pins
 * TORUS_STATE_DIR process-globally (one shared state root for every
 * trigger), so driver-auto chains serialize process-wide: a second fire
 * while any chain is in flight answers 409 and the sender re-fires
 * later; the sentinel clears when the chain settles. Each chain's
 * produced plan artifact persists in triggers-state.json under the repo
 * the moment the plan stage lands, and a fire that lands while the
 * chain's work state is not complete resumes from that plan (a crash
 * loses one stage, not the chain). An optional github.pr block passes
 * the PR stage's title override to the chain.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import {
	createServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { type AutoOptions, defaultStageRunner, startAuto } from "../auto/index.js";
import { configFilePath, readSection } from "../config/loader.js";
import { projectStateDir, readJson, sleep, torusHome, writeJson } from "../fsutil.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { AGENT_NAME_RE, type DelegationRecord, listDelegations, repoRoot } from "../registry.js";
import { AGENTS, type DelegationOutcome, runDelegation } from "../roster/index.js";
import { fenceField } from "../untrusted.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
};

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
	/** Cadence in minutes; absent for event-driven (github) triggers. */
	everyMinutes?: number;
	agent: string;
	task: string;
	model?: string;
	/** Optional webhook endpoint: POST <path> with X-Torus-Secret fires this trigger. */
	webhook?: { path: string };
	/**
	 * Optional github block: turns the trigger's webhook endpoint into a
	 * GitHub-class one — HMAC (X-Hub-Signature-256) auth instead of the
	 * static secret, event/action/repo routing before any spawn, and the
	 * delegation running in `cwd`.
	 */
	github?: {
		/** owner/name the payload's repository.full_name must equal exactly. */
		repo: string;
		/** Absolute checkout path used as the delegation cwd — operator config. */
		cwd: string;
		/** Explicit webhook secret; absent → one is minted per trigger. */
		secret?: string;
		/** X-GitHub-Event values that may fire this trigger. */
		events: string[];
		/** Optional payload.action filter on top of the event filter. */
		actions?: string[];
		/**
		 * "auto" turns the fire into an in-process startAuto stage chain
		 * instead of a fireRun delegation (crash-resumable, serialized
		 * process-wide). Absent → reviewer-class: the fireRun path,
		 * unchanged.
		 */
		driver?: "auto";
		/**
		 * Optional PR stage for driver-class chains: opens the pull
		 * request after a fully passing lens stage, `title` overriding the
		 * plan's H1 (docs/auto.md). Absent → the chain ends at lens,
		 * unchanged.
		 */
		pr?: { title?: string };
	};
}

/** Caps for serve section triggers — max count and floor on the interval. */
export const MAX_TRIGGERS = 8;
export const MIN_EVERY_MINUTES = 5;
/** Webhook paths must sit under /hook/ with a slug remainder (a-z, 0-9, -). */
const WEBHOOK_PATH_RE = /^\/hook\/[a-z0-9-]+$/;
/** Webhook body cap — bigger requests drain, then answer 413. */
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** Payload nesting rendered into a task; deeper values become "[truncated]". */
const PAYLOAD_DEPTH_CAP = 8;
/** GitHub repository.full_name shape: owner/name, no slashes inside either. */
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const DEFAULT_CONFIG: ServeConfig = { port: 4747, bind: "127.0.0.1" };

/**
 * House read of the config's "serve" section, fields falling to their
 * defaults when absent or wrongly typed; a malformed config.json or a
 * non-object serve section degrades to the defaults with one warning on
 * stderr here — loadServeConfig runs exactly once, at startup, never per
 * request.
 *
 * `tokenPath` names the auth-token file to mint or read (default
 * ~/.torus/serve/auth.json): it points at runtime state, not a secret, so it
 * rides in the config like the other keys. auth.json and
 * triggers-state.json (bearer token, webhook secrets, lastFired) are minted
 * runtime state — the config file itself carries no secrets.
 */
export function loadServeConfig(): ServeConfig {
	const section = readSection<Partial<ServeConfig>>("serve");
	if (section.warning !== undefined) {
		process.stderr.write(`torus serve: ${section.warning}\n`);
	}
	const raw = section.value ?? {};
	return {
		port: typeof raw.port === "number" && raw.port >= 0 ? raw.port : DEFAULT_CONFIG.port,
		bind: typeof raw.bind === "string" && raw.bind.length > 0 ? raw.bind : DEFAULT_CONFIG.bind,
		tokenPath: typeof raw.tokenPath === "string" ? raw.tokenPath : undefined,
		triggers: raw.triggers,
	};
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
export function triggerIntervalMs(trigger: { everyMinutes: number }): number {
	return trigger.everyMinutes * 60_000;
}

/**
 * Validate the raw `serve` section `triggers` value. Absent/null/[] schedules
 * nothing; anything else must be a well-formed array or startup refuses —
 * the error names the trigger and the offending field so the file can be
 * fixed in one pass.
 */
export function validateTriggers(raw: unknown): { triggers: ServeTrigger[]; error: string | null } {
	if (raw === undefined || raw === null) return { triggers: [], error: null };
	if (!Array.isArray(raw)) {
		return { triggers: [], error: 'serve section "triggers" must be an array of trigger objects' };
	}
	if (raw.length > MAX_TRIGGERS) {
		return {
			triggers: [],
			error: `serve section "triggers" lists ${raw.length} entries — the maximum is ${MAX_TRIGGERS}`,
		};
	}
	const agentNames = delegatableAgentNames();
	const seen = new Set<string>();
	const seenWebhookPaths = new Map<string, string>();
	const triggers: ServeTrigger[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const entry = raw[i];
		if (!isRecord(entry)) {
			return { triggers: [], error: `serve section trigger [${i}] must be an object` };
		}
		const name = entry.name;
		if (typeof name !== "string" || !AGENT_NAME_RE.test(name)) {
			return {
				triggers: [],
				error: `serve section trigger [${i}]: "name" must be a slug matching ${AGENT_NAME_RE} (got ${JSON.stringify(name)})`,
			};
		}
		if (seen.has(name)) {
			return {
				triggers: [],
				error: `serve section trigger "${name}": duplicate name — trigger names must be unique`,
			};
		}
		const github = entry.github;
		if (github !== undefined && !isRecord(github)) {
			return {
				triggers: [],
				error: `serve section trigger "${name}": "github" must be an object`,
			};
		}
		// Scheduled triggers need a cadence; a github trigger is event-driven,
		// so everyMinutes is optional there (a present value still needs the
		// sane floor — the same error names the field either way).
		const everyMinutes = entry.everyMinutes;
		if (everyMinutes !== undefined || !isRecord(github)) {
			if (
				typeof everyMinutes !== "number" ||
				!Number.isInteger(everyMinutes) ||
				everyMinutes < MIN_EVERY_MINUTES
			) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "everyMinutes" must be an integer ≥ ${MIN_EVERY_MINUTES} (got ${JSON.stringify(everyMinutes)})`,
				};
			}
		}
		const agent = entry.agent;
		if (typeof agent !== "string" || agent.length === 0) {
			return {
				triggers: [],
				error: `serve section trigger "${name}": "agent" must be a non-empty string`,
			};
		}
		if (!agentNames.includes(agent)) {
			return {
				triggers: [],
				error: `serve section trigger "${name}": unknown agent "${agent}" — must be a delegatable roster agent (${agentNames.join(", ")})`,
			};
		}
		const task = entry.task;
		if (typeof task !== "string" || task.length === 0) {
			return {
				triggers: [],
				error: `serve section trigger "${name}": "task" must be a non-empty string`,
			};
		}
		const model = entry.model;
		if (model !== undefined && typeof model !== "string") {
			return {
				triggers: [],
				error: `serve section trigger "${name}": "model" must be a string`,
			};
		}
		const webhook = entry.webhook;
		if (webhook !== undefined) {
			if (!isRecord(webhook)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "webhook" must be an object`,
				};
			}
			const hookPath = webhook.path;
			if (typeof hookPath !== "string" || !WEBHOOK_PATH_RE.test(hookPath)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "webhook.path" must start with "/hook/" followed by a slug of lowercase letters, digits, and hyphens (got ${JSON.stringify(hookPath)})`,
				};
			}
			const hookOwner = seenWebhookPaths.get(hookPath);
			if (hookOwner !== undefined) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": webhook path "${hookPath}" is already used by trigger "${hookOwner}" — webhook paths must be unique`,
				};
			}
			seenWebhookPaths.set(hookPath, name);
		}
		if (isRecord(github)) {
			if (webhook === undefined) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": a "github" trigger answers POSTs at a webhook endpoint — add a "webhook.path"`,
				};
			}
			const repo = github.repo;
			if (typeof repo !== "string" || !GITHUB_REPO_RE.test(repo)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.repo" must be "owner/name" (got ${JSON.stringify(repo)})`,
				};
			}
			const cwd = github.cwd;
			if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.cwd" must be an absolute path to the repo checkout (got ${JSON.stringify(cwd)})`,
				};
			}
			const secret = github.secret;
			if (secret !== undefined && (typeof secret !== "string" || secret.length === 0)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.secret" must be a non-empty string (the same value configured in the repo's webhook settings)`,
				};
			}
			const events = github.events;
			if (
				!Array.isArray(events) ||
				events.length === 0 ||
				events.some((e) => typeof e !== "string" || e.length === 0)
			) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.events" must be a non-empty array of strings (e.g. ["pull_request"])`,
				};
			}
			const actions = github.actions;
			if (
				actions !== undefined &&
				(!Array.isArray(actions) || actions.some((a) => typeof a !== "string" || a.length === 0))
			) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.actions" must be an array of strings (e.g. ["opened", "synchronize"])`,
				};
			}
			const driver = github.driver;
			if (driver !== undefined && driver !== "auto") {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.driver" must be "auto" (got ${JSON.stringify(driver)})`,
				};
			}
			const pr = github.pr;
			if (pr !== undefined && !isRecord(pr)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.pr" must be an object`,
				};
			}
			const prTitle = isRecord(pr) ? pr.title : undefined;
			if (prTitle !== undefined && (typeof prTitle !== "string" || prTitle.length === 0)) {
				return {
					triggers: [],
					error: `serve section trigger "${name}": "github.pr.title" must be a non-empty string when present`,
				};
			}
		}
		seen.add(name);
		triggers.push({
			name,
			everyMinutes: typeof everyMinutes === "number" ? everyMinutes : undefined,
			agent,
			task,
			model: typeof model === "string" && model.length > 0 ? model : undefined,
			webhook: isRecord(webhook) ? { path: webhook.path as string } : undefined,
			github: isRecord(github)
				? {
						repo: github.repo as string,
						cwd: github.cwd as string,
						secret: typeof github.secret === "string" ? github.secret : undefined,
						events: github.events as string[],
						actions: Array.isArray(github.actions) ? (github.actions as string[]) : undefined,
						driver: github.driver === "auto" ? "auto" : undefined,
						pr: isRecord(github.pr)
							? { title: typeof github.pr.title === "string" ? github.pr.title : undefined }
							: undefined,
					}
				: undefined,
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
	/** Last-known plan artifact for driver-class github triggers, keyed by repo. */
	autoPlanPath?: unknown;
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
		// A github trigger's secret may be explicit config — the same value the
		// operator pastes into the repo's webhook settings; it wins over any
		// stale minted state and is never re-minted.
		const explicit = trigger.github?.secret;
		if (typeof explicit === "string" && explicit.length > 0) {
			secrets[trigger.name] = explicit;
			continue;
		}
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
	// An explicit-secret github trigger can leave nothing to write — the file
	// only exists (and only needs the perms refresh) when state was minted or
	// already held secrets.
	if (changed || existsSync(triggersStatePath())) {
		chmodSync(triggersStatePath(), 0o600);
	}
	return { secrets, created };
}

/** Constant-time bearer comparison (length-hiding via sha256 digests). */
function tokenMatches(provided: string, expected: string): boolean {
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * Verify a GitHub webhook signature: HMAC-sha256 over the raw body with the
 * trigger's secret, compared timing-safely against the hex digest in
 * X-Hub-Signature-256 (the sha256= prefix is tolerated but not required).
 * Both sides hash to fixed-length digests like tokenMatches, so a
 * wrong-length signature leaks no length information.
 */
function signatureMatches(header: string, rawBody: string, secret: string): boolean {
	const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
	const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
	return tokenMatches(provided, expected);
}

/**
 * The github-class routing gate: every check compares against trusted
 * trigger config, never payload data, and any mismatch answers 404 named
 * without spawning — the delegation's checkout comes from the trigger's
 * own `cwd`, never from the payload. Returns the refusal message, or null
 * when the request routes.
 */
function githubRouteRefusal(
	trigger: ServeTrigger,
	github: NonNullable<ServeTrigger["github"]>,
	eventHeader: unknown,
	payload: Record<string, unknown>,
): string | null {
	const event = typeof eventHeader === "string" ? eventHeader : "";
	if (event.length === 0) {
		return `missing "X-GitHub-Event" header — GitHub always sends it`;
	}
	if (!github.events.includes(event)) {
		return `event "${event}" is not in trigger "${trigger.name}" events [${github.events.join(", ")}]`;
	}
	const repository = payload.repository;
	const fullName =
		typeof repository === "object" && repository !== null && !Array.isArray(repository)
			? (repository as Record<string, unknown>).full_name
			: undefined;
	if (fullName !== github.repo) {
		return `payload repository.full_name ${JSON.stringify(fullName ?? null)} does not match trigger "${trigger.name}" repo "${github.repo}" — the trigger's own cwd is the only checkout`;
	}
	if (github.actions !== undefined) {
		const action = payload.action;
		if (typeof action !== "string" || !github.actions.includes(action)) {
			return `payload action ${JSON.stringify(action ?? null)} is not in trigger "${trigger.name}" actions [${github.actions.join(", ")}]`;
		}
	}
	return null;
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
 * data with its type visible, never merged into the task as bare prose, and
 * each value is then wrapped in an untrusted-input fence (fenceField) so
 * payload-controlled text cannot inject instructions into the task. The
 * fence label is the field's dotted reference as the template wrote it,
 * including the `payload.` prefix — e.g. {{payload.issue.title}} renders
 * under the label `payload.issue.title`. The substitution mechanism only has
 * the bare dotted path available (the regex capture drops the `payload.`
 * prefix), so the prefix is re-attached here to keep the label reading as
 * the template's own reference; labels are trusted frame text, and a
 * reference can only match [A-Za-z0-9_-] segments joined by dots, so it can
 * never carry a newline or `]` that would break the begin mark. Templates
 * with no payload references render byte-identical (no fence, no preamble);
 * missing fields still render empty with no fence. Values nested deeper
 * than PAYLOAD_DEPTH_CAP levels render "[truncated]" inside the fence.
 */
export function renderTaskTemplate(task: string, payload: Record<string, unknown>): string {
	return task.replace(PAYLOAD_FIELD_RE, (_match, fieldPath: string) => {
		let current: unknown = payload;
		for (const segment of fieldPath.split(".")) {
			if (typeof current !== "object" || current === null || Array.isArray(current)) return "";
			current = (current as Record<string, unknown>)[segment];
			if (current === undefined) return "";
		}
		return fenceField(`payload.${fieldPath}`, stringifyCapped(current, 1));
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

/** The stage-runner half of AutoOptions — the test seam's type. */
type AutoStageRunner = NonNullable<AutoOptions["runStage"]>;

let autoRunnerForTesting: AutoStageRunner | null = null;

/** Test-only: substitute the auto stage runner (null restores the real one). */
export function setAutoRunnerForTesting(runner: AutoStageRunner | null): void {
	autoRunnerForTesting = runner;
}

/**
 * The in-flight auto chain sentinel. startAuto pins TORUS_STATE_DIR
 * process-globally (its env pin is not per-call) and every trigger shares
 * one state root, so the plan stage's set-difference poll would race any
 * other chain's plan child: two concurrent chains could adopt each
 * other's plan and gate on the same stem. Driver-auto chains therefore
 * serialize process-wide — a second fire while ANY chain is in flight
 * answers 409 and the sender re-fires later. The sentinel clears when
 * the chain's promise settles (success, failure, or refusal). Per-repo
 * concurrency is future scope with per-repo state roots.
 */
let autoRunInFlight = false;

/**
 * Work-state slug for a plan path — the same restriction auto's workSlug
 * applies, so the crash-resume poll reads the state file work_start binds.
 */
function workSlugForPlan(planPath: string): string {
	const slug = path
		.basename(planPath, ".md")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 120);
	return slug.length > 0 ? slug : "plan";
}

/**
 * The driver's completion signal for a plan's chain: the work state file
 * under the same state root startAuto pins, status "complete". Only a
 * present file that reads complete counts — anything else (missing,
 * active, paused) leaves the chain resumable.
 */
function workChainComplete(stateDir: string, planPath: string): boolean {
	const file = path.join(stateDir, "work", `${workSlugForPlan(planPath)}.json`);
	const state = readJson<{ status?: unknown } | null>(file, null);
	return state !== null && state.status === "complete";
}

/** The last persisted plan artifact for a repo, or null when none. */
function readAutoPlanState(repo: string): string | null {
	const state = readJson<Record<string, WebhookSecretState>>(triggersStatePath(), {});
	const persisted = state[repo]?.autoPlanPath;
	return typeof persisted === "string" && persisted.length > 0 ? persisted : null;
}

/** Record the last-known plan artifact for a repo in triggers-state.json. */
function persistAutoPlan(repo: string, planPath: string): void {
	const state = readJson<Record<string, WebhookSecretState>>(triggersStatePath(), {});
	state[repo] = { ...state[repo], autoPlanPath: planPath };
	writeJson(triggersStatePath(), state);
	// The file holds webhook secrets too — keep it owner-only like the
	// secret minter does.
	chmodSync(triggersStatePath(), 0o600);
}

/**
 * Driver-class fire: the rendered task becomes an in-process startAuto
 * objective and the chain runs in this process's background. The response
 * acknowledges with a run-id analog (the chain is not a delegation, so
 * there is no delegationId to await) — the sentinel is the overlap gate,
 * and the chain's plan artifact persists for crash-resume the moment the
 * plan stage completes.
 */
async function fireAutoRun(
	res: ServerResponse,
	trigger: ServeTrigger,
	github: NonNullable<ServeTrigger["github"]>,
	payload: Record<string, unknown>,
): Promise<void> {
	const repo = github.repo;
	if (autoRunInFlight) {
		return sendJson(res, 409, {
			ok: false,
			error: "auto-already-running",
			message: "auto already running — the chain settles on its own; fire again later",
		});
	}
	// The rendered task IS the objective: fenced payload fields exactly like
	// every webhook fire, with the driven checkout coming from operator
	// config — the payload never names a path.
	const objective = renderTaskTemplate(trigger.task, payload);
	const persistedPlan = readAutoPlanState(repo);
	// The same state root startAuto is about to pin: the work state file it
	// would have completed lives there.
	const stateDir = projectStateDir();
	const resume = persistedPlan !== null && !workChainComplete(stateDir, persistedPlan);
	const runId = `srv-${randomUUID().slice(0, 8)}`;
	const autoRunner = autoRunnerForTesting ?? undefined;
	// Crash-resume: the plan artifact persists the moment the plan stage
	// lands, not when the chain settles — a run killed at GATE or
	// mid-execute leaves a resumable plan behind. The settle-time persist
	// below stays as a fallback. The wrapper runs whether the stage runner
	// is injected (tests) or the default one.
	const baseRunner = autoRunner ?? defaultStageRunner(stateDir);
	const runStage: AutoStageRunner = async (stage, ctx) => {
		const result = await baseRunner(stage, ctx);
		if (stage === "plan" && result.ok && typeof result.artifact === "string") {
			persistAutoPlan(repo, result.artifact);
		}
		return result;
	};
	const run = startAuto({
		objective,
		cwd: github.cwd,
		...(resume && persistedPlan !== null ? { planPath: persistedPlan } : {}),
		...(github.pr ? { pr: { title: github.pr.title } } : {}),
		runStage,
	})
		.then((report) => {
			const planStage = report.stages.find((stage) => stage.stage === "plan");
			if (planStage?.ok === true && typeof planStage.artifact === "string") {
				persistAutoPlan(repo, planStage.artifact);
			}
		})
		.catch((err: unknown) => {
			process.stderr.write(
				`torus serve: auto run ${runId} for ${repo} failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		})
		.finally(() => {
			autoRunInFlight = false;
		});
	autoRunInFlight = true;
	return sendJson(res, 200, { ok: true, auto: runId, ...(resume ? { resumed: true } : {}) });
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
	const github = route.trigger.github;
	if (github === undefined) {
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
	// GitHub-class trigger: HMAC over the RAW body BEFORE any parse — the
	// body bytes are the authenticated surface, and parsing unverified JSON
	// first would hand a sender a parse oracle on an unauthenticated route.
	let rawBody: string;
	try {
		rawBody = await readRawBody(req, WEBHOOK_MAX_BODY_BYTES);
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
	const signature = req.headers["x-hub-signature-256"];
	if (typeof signature !== "string" || !signatureMatches(signature, rawBody, route.secret)) {
		return sendJson(res, 401, {
			ok: false,
			error: "unauthorized",
			message: "missing or invalid X-Hub-Signature-256 for this trigger's secret",
		});
	}
	let payload: Record<string, unknown>;
	try {
		payload = parseJsonObject(rawBody);
	} catch (err) {
		return sendJson(res, 400, {
			ok: false,
			error: "invalid-body",
			message: err instanceof Error ? err.message : String(err),
		});
	}
	const refusal = githubRouteRefusal(route.trigger, github, req.headers["x-github-event"], payload);
	if (refusal !== null) {
		return sendJson(res, 404, { ok: false, error: "no-matching-event", message: refusal });
	}
	if (github.driver === "auto") {
		return fireAutoRun(res, route.trigger, github, payload);
	}
	// Routed: the task template renders through the same fence as every
	// webhook fire, and the delegation runs in the trigger config's cwd.
	const task = renderTaskTemplate(route.trigger.task, payload);
	const fired = fireRun(route.trigger.agent, task, github.cwd, route.trigger.model ?? null);
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

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
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
	return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(raw: string): Record<string, unknown> {
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

async function readJsonObject(
	req: IncomingMessage,
	maxBytes: number,
): Promise<Record<string, unknown>> {
	return parseJsonObject(await readRawBody(req, maxBytes));
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
		exitCode: record.exitCode,
		error: record.error,
		noProgress: record.noProgress,
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
	skills?: string[],
): { handleTag: string; guarded: Promise<GuardedOutcome> } {
	const handleTag = `srv-${randomUUID().slice(0, 8)}`;
	// parentSession null: no session to attribute in a headless server.
	// announce/emitResult false: this process has no transcript sender,
	// so markers would be no-ops anyway — a headless server stays deliberate.
	const outcome = runDelegation(
		agent,
		task,
		cwd,
		undefined,
		null,
		handleTag,
		skills,
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
	const { agent, task, model, cwd, skills, wait } = body;
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
	// Absent skills means no skills (roster treats it as unset); present, it
	// must be an array of non-empty strings. Containment (which paths are
	// allowed at all) is roster's pre-flight job, not ours.
	let skillPaths: string[] | undefined;
	if (skills !== undefined) {
		if (
			!Array.isArray(skills) ||
			skills.some((entry) => typeof entry !== "string" || entry.length === 0)
		) {
			return sendJson(res, 400, {
				ok: false,
				error: "invalid-request",
				message: '"skills" must be an array of non-empty strings',
			});
		}
		skillPaths = skills;
	}

	const { handleTag, guarded } = fireRun(
		agent,
		task,
		typeof cwd === "string" ? cwd : undefined,
		typeof model === "string" && model.trim().length > 0 ? model : null,
		skillPaths,
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
			verdict: {
				ok: outcome.ok,
				exitCode: outcome.details.exitCode ?? null,
				turns: outcome.details.turns ?? null,
				stopped: outcome.details.stopped ?? null,
				error: outcome.details.error ?? null,
				noProgress: outcome.details.noProgress ?? null,
			},
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
	const runIdMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
	if (url.pathname === "/run" || url.pathname === "/runs" || runIdMatch) {
		if (!authorized(req, token)) {
			return sendJson(res, 401, { ok: false, error: "unauthorized" });
		}
		if (url.pathname === "/runs") {
			if (req.method !== "GET") return sendJson(res, 404, { ok: false, error: "not-found" });
			return sendJson(res, 200, { runs: listDelegations().map(publicRun) });
		}
		if (runIdMatch) {
			if (req.method !== "GET") return sendJson(res, 404, { ok: false, error: "not-found" });
			const id = runIdMatch[1];
			const record = listDelegations().find((r) => r.id === id);
			if (!record) {
				return sendJson(res, 404, { ok: false, error: "run-not-found", id });
			}
			return sendJson(res, 200, { run: publicRun(record) });
		}
		if (req.method !== "POST") return sendJson(res, 404, { ok: false, error: "not-found" });
		return handleRunRequest(req, res);
	}
	const route = webhooks.get(url.pathname);
	if (route) {
		if (req.method !== "POST") {
			return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
		}
		// GitHub-class endpoints authenticate with HMAC over the raw body
		// inside handleWebhookRequest; the static-secret check below is the
		// only auth for classic webhook triggers (behavior unchanged).
		if (route.trigger.github === undefined) {
			const provided = req.headers["x-torus-secret"];
			if (typeof provided !== "string" || !tokenMatches(provided, route.secret)) {
				return sendJson(res, 401, { ok: false, error: "unauthorized" });
			}
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
		// Read-modify-write: the state file also carries keys this scheduler
		// does not own (persistAutoPlan's autoPlanPath crash-resume entries
		// under the repo key) — a from-scratch rebuild would erase them on
		// every fire. Merge the bookkeeping over what is already there.
		const state = readJson<Record<string, WebhookSecretState>>(triggersStatePath(), {});
		for (const entry of entries) {
			if (entry.lastFired !== null || entry.webhookSecret !== null) {
				state[entry.trigger.name] = {
					...state[entry.trigger.name],
					...(entry.lastFired !== null ? { lastFired: entry.lastFired } : {}),
					...(entry.webhookSecret !== null ? { webhookSecret: entry.webhookSecret } : {}),
				};
			}
		}
		writeJson(triggersStatePath(), state);
		chmodSync(triggersStatePath(), 0o600);
	};
	const attemptFire = (entry: TriggerEntry): boolean => {
		const now = Date.now();
		if (entry.inFlight) return false;
		const everyMinutes = entry.trigger.everyMinutes;
		if (
			everyMinutes !== undefined &&
			entry.lastFired !== null &&
			now - entry.lastFired < everyMinutes * 60_000
		) {
			return false;
		}
		entry.inFlight = true;
		entry.lastFired = now;
		persist();
		const { guarded } = fireRun(
			entry.trigger.agent,
			entry.trigger.task,
			entry.trigger.github?.cwd,
			entry.trigger.model ?? null,
		);
		const settle = () => {
			entry.inFlight = false;
		};
		void guarded.then(settle, settle);
		return true;
	};
	for (const entry of entries) {
		// A trigger without a cadence (github-class, event-driven) schedules
		// nothing — its fires come from its webhook endpoint.
		if (entry.trigger.everyMinutes === undefined) continue;
		const timer = setInterval(
			() => attemptFire(entry),
			triggerIntervalMs({ everyMinutes: entry.trigger.everyMinutes }),
		);
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
 * clean error naming the port and the serve config override.
 */
export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
	if (!gateExtension("serve", PLATFORM_SUPPORT)) {
		throw new Error("torus serve unsupported on this platform — check TORUS_PLATFORM");
	}
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
						`port ${port} on ${bind} is already in use — stop the other listener or set "port" in the serve section of ${configFilePath()} to pick another`,
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
