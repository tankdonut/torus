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
import { type DelegationRecord, listDelegations, repoRoot } from "../registry.js";
import { type DelegationOutcome, runDelegation } from "../roster/index.js";

export interface ServeConfig {
	port: number;
	bind: string;
	/** Explicit auth-token file; default ~/.torus/serve/auth.json. */
	tokenPath?: string;
}

const DEFAULT_CONFIG: ServeConfig = { port: 4747, bind: "127.0.0.1" };

/** House read-with-fallback: missing or malformed serve.json yields defaults. */
export function loadServeConfig(): ServeConfig {
	const file = readJson<Partial<ServeConfig>>(serveConfigPath(), {});
	return {
		port: typeof file.port === "number" && file.port >= 0 ? file.port : DEFAULT_CONFIG.port,
		bind: typeof file.bind === "string" && file.bind.length > 0 ? file.bind : DEFAULT_CONFIG.bind,
		tokenPath: typeof file.tokenPath === "string" ? file.tokenPath : undefined,
	};
}

export function serveConfigPath(): string {
	return path.join(torusHome(), "serve.json");
}

export function defaultAuthPath(): string {
	return path.join(torusHome(), "serve", "auth.json");
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

const VERSION =
	readJson<{ version?: string }>(path.join(repoRoot(), "package.json"), {}).version ?? "unknown";

const MAX_BODY_BYTES = 1024 * 1024;
/** How long wait:true rides along a run before answering 504. */
const WAIT_CAP_MS = 10 * 60 * 1000;
/** Polling budget for spotting a fired run's registry record. */
const RUN_ID_DEADLINE_MS = 10_000;
const RUN_ID_POLL_MS = 20;

class BodyError extends Error {}

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

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > MAX_BODY_BYTES) throw new BodyError("request body exceeds 1 MiB");
		chunks.push(buf);
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
		body = await readJsonObject(req);
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

	const delegationId = await awaitRunId(handleTag, guarded);
	if (delegationId !== null) {
		return sendJson(res, 200, { delegationId });
	}
	const settled = await guarded;
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
	close: () => Promise<void>;
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
	const port = options.port ?? config.port;
	const bind = options.bind ?? config.bind;
	const tokenPath = options.tokenPath ?? config.tokenPath ?? defaultAuthPath();
	const { token, created } = loadOrMintToken(tokenPath);
	if (created) {
		process.stdout.write(`serve token: ${token}\n`);
	}

	const server = createServer((req, res) => {
		void handleRequest(req, res, token).catch((err: unknown) => {
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
	return {
		server,
		port: boundPort,
		bind,
		token,
		close: () =>
			new Promise<void>((resolve) => {
				// fetch keep-alive sockets would otherwise hold close() open forever
				server.closeIdleConnections();
				server.close(() => resolve());
			}),
	};
}
