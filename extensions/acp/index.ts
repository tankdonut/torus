/**
 * torus — ACP support in both directions over stdio (v1, stable).
 *
 * Consume (client role): external ACP-speaking agents as delegatable
 * children. Speaks the Agent Client Protocol over stdio as the CLIENT —
 * torus consumes the agent. Reference: github.com/agentclientprotocol/
 * agent-client-protocol, docs/protocol/v1/ (repo formerly zed-industries),
 * accessed 2026-10-09; initialization.mdx blob ea16b093. No
 * @agentclientprotocol/sdk dependency — node primitives only, mirroring
 * extensions/rpc.ts's line-buffered newline-delimited JSON child stdio
 * handling.
 *
 * One delegation = one fresh child process: initialize → session/new →
 * session/prompt, with session/update notifications folded into the result.
 * No session/load — every run starts cold. Permissions are fail-closed: the
 * client advertises no capabilities, so an inbound session/request_permission
 * is answered with the cancelled outcome and the denial is surfaced as an
 * activity line.
 *
 * Serve (agent role): `torus acp-agent` answers the same protocol as the
 * AGENT so editors (Zed, JetBrains) can drive torus — see runAcpAgentRole()
 * at the bottom of this module.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childExtensionArgs, resolveEngineBin } from "../engine-child.js";
import { torusHome } from "../fsutil.js";
import { repoRoot } from "../registry.js";
import { RpcChild } from "../rpc.js";

const STDERR_CAP = 64 * 1024;
const LINE_CAP = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 600_000;

/** ACP agent names land in registry log filenames, so they take the roster's charset. */
const ACP_NAME_RE = /^[a-z0-9-]+$/;

export interface AcpAgentSpec {
	command: string;
	args: string[];
	env: Record<string, string>;
}

function warn(text: string): void {
	process.stderr.write(`torus: ${text}\n`);
}

/** torus version for the initialize clientInfo — read from package.json next to this module. */
function torusVersion(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
		) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function specFromEntry(name: string, entry: unknown): AcpAgentSpec | null {
	if (typeof entry !== "object" || entry === null) {
		warn(`acp.json agent "${name}" is not an object — skipped`);
		return null;
	}
	const fields = entry as Record<string, unknown>;
	const command = fields["command"];
	if (typeof command !== "string" || command.length === 0) {
		warn(`acp.json agent "${name}" has no non-empty "command" — skipped`);
		return null;
	}
	let args: string[] = [];
	if (fields["args"] !== undefined) {
		if (!Array.isArray(fields["args"]) || fields["args"].some((a) => typeof a !== "string")) {
			warn(`acp.json agent "${name}" has a non-string-array "args" — skipped`);
			return null;
		}
		args = fields["args"] as string[];
	}
	let env: Record<string, string> = {};
	if (fields["env"] !== undefined) {
		if (typeof fields["env"] !== "object" || fields["env"] === null) {
			warn(`acp.json agent "${name}" has a non-object "env" — skipped`);
			return null;
		}
		for (const [key, value] of Object.entries(fields["env"])) {
			if (typeof value !== "string") {
				warn(`acp.json agent "${name}" env value "${key}" is not a string — skipped`);
				return null;
			}
		}
		env = fields["env"] as Record<string, string>;
	}
	return { command, args, env };
}

/**
 * Agents from `acp.json` under TORUS_HOME (default `~/.torus`), read per call
 * so edits apply without a restart. Shape:
 * `{"agents": {"<name>": {"command": "…", "args": […], "env": {"KEY": "value"}}}}`
 * (`args` defaults to [], `env` is merged over the inherited child env). An
 * absent file yields {}; malformed JSON, a non-object root, or a bad entry
 * warns on stderr and skips just that entry — never a hard failure.
 */
export function acpAgents(): Record<string, AcpAgentSpec> {
	const file = path.join(torusHome(), "acp.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		warn(`acp.json is not valid JSON (${String(error)}) — no ACP agents loaded`);
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) {
		warn("acp.json root is not an object — no ACP agents loaded");
		return {};
	}
	const agents = (parsed as Record<string, unknown>)["agents"];
	if (agents === undefined) return {};
	if (typeof agents !== "object" || agents === null) {
		warn('acp.json "agents" is not an object — no ACP agents loaded');
		return {};
	}
	const out: Record<string, AcpAgentSpec> = {};
	for (const [name, entry] of Object.entries(agents)) {
		if (!ACP_NAME_RE.test(name)) {
			warn(`acp.json agent name "${name}" must match ${ACP_NAME_RE.toString()} — skipped`);
			continue;
		}
		const spec = specFromEntry(name, entry);
		if (spec) out[name] = spec;
	}
	return out;
}

export function acpAgentNames(): string[] {
	return Object.keys(acpAgents()).sort();
}

interface AcpEvents {
	/** Inbound notification (no id) — session/update and friends. */
	onNotification?: (method: string, params: Record<string, unknown>) => void;
	/** Inbound request (has id) — session/request_permission and friends. */
	onRequest?: (record: Record<string, unknown>) => void;
}

interface Pending {
	resolve: (result: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

/**
 * Minimal ACP v1 client transport: newline-delimited JSON-RPC on the child's
 * stdin/stdout. Requests carry a numeric id; `{"jsonrpc":"2.0","id":N,…}`
 * records resolve the pending promise (an `error` member rejects it).
 * Records with a `method` and no id are notifications; with an id they are
 * server→client requests answered via respond().
 */
export class AcpChild {
	private proc: ChildProcess;
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly events: AcpEvents;
	private readonly stdoutDecoder = new StringDecoder("utf8");
	private readonly stderrDecoder = new StringDecoder("utf8");
	readonly exited: Promise<number>;
	stderrText = "";

	constructor(
		command: string,
		args: string[],
		env: Record<string, string>,
		cwd: string,
		events: AcpEvents,
	) {
		this.events = events;
		this.proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
		this.exited = new Promise((resolve) => {
			this.proc.on("error", () => resolve(1));
			this.proc.on("close", (code) => resolve(code ?? 0));
		});
		const failPending = (reason: string): void => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(reason));
			}
			this.pending.clear();
		};
		this.proc.stdin?.on("error", (error) => failPending(`acp stdin error: ${String(error)}`));
		this.proc.on("error", (error) => failPending(`acp child error: ${String(error)}`));
		this.proc.on("close", (code) => {
			this.buffer += this.stdoutDecoder.end();
			if (this.stderrText.length < STDERR_CAP) {
				this.stderrText += this.stderrDecoder.end().slice(0, STDERR_CAP - this.stderrText.length);
			}
			failPending(`acp agent closed before responding${code !== null ? ` (exit ${code})` : ""}`);
		});
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += this.stdoutDecoder.write(chunk);
			// A line longer than LINE_CAP cannot be a valid JSON-RPC record; keep
			// the tail so a real response following runaway garbage still parses.
			if (this.buffer.length > LINE_CAP) this.buffer = this.buffer.slice(-LINE_CAP);
			let newline = this.buffer.indexOf("\n");
			while (newline !== -1) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.handleLine(line);
				newline = this.buffer.indexOf("\n");
			}
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			if (this.stderrText.length >= STDERR_CAP) return;
			const decoded = this.stderrDecoder.write(chunk);
			this.stderrText += decoded.slice(0, STDERR_CAP - this.stderrText.length);
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof record !== "object" || record === null) return;
		const message = record as Record<string, unknown>;
		const method = message["method"];
		if (typeof method === "string") {
			if ("id" in message) this.events.onRequest?.(message);
			else this.events.onNotification?.(method, objectOrEmpty(message["params"]));
			return;
		}
		if (typeof message["id"] === "number" && this.pending.has(message["id"])) {
			const pending = this.pending.get(message["id"]);
			if (!pending) return;
			this.pending.delete(message["id"]);
			clearTimeout(pending.timer);
			if (typeof message["error"] === "object" && message["error"] !== null) {
				const err = message["error"] as Record<string, unknown>;
				const detail = typeof err["message"] === "string" ? err["message"] : JSON.stringify(err);
				pending.reject(new Error(`acp ${pending.method} error: ${detail}`));
				return;
			}
			pending.resolve(objectOrEmpty(message["result"]));
		}
	}

	private write(message: Record<string, unknown>): void {
		this.proc.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	/** Send a JSON-RPC request; resolves with the response's result object. */
	request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
	): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.kill();
				reject(new Error(`acp timeout awaiting ${method} response`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Answer a server→client request (e.g. session/request_permission). */
	respond(id: number, result: Record<string, unknown>): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		try {
			this.proc.kill(signal);
		} catch {
			// already dead
		}
	}
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface AcpRunResult {
	ok: boolean;
	finalText: string;
	stderr: string;
	sessionId: string | null;
	/** ACP stopReason ("end_turn", "cancelled", …) or a transport-failure label. */
	stopReason: string;
	/** Prompt turns completed; ACP exposes no per-turn signal, so a finished run counts one. */
	turns: number;
	toolCalls: number;
	toolResults: number;
	permissionDenials: number;
}

export interface AcpRunHooks {
	onAction?: (line: string) => void;
	onSession?: (sessionId: string) => void;
	onControl?: (control: { stop: () => void }) => void;
}

/**
 * Drive one ACP delegation end to end: spawn, initialize (verifying
 * protocolVersion 1), session/new, session/prompt, fold updates, settle on
 * the prompt response, kill the child. `end_turn` settles ok; any other
 * stopReason, a JSON-RPC error, or child death/stdin close before the
 * response settles not-ok naming the agent.
 */
export async function runAcpAgent(
	name: string,
	spec: AcpAgentSpec,
	cwd: string,
	task: string,
	hooks: AcpRunHooks = {},
): Promise<AcpRunResult> {
	let finalText = "";
	let stopped = false;
	const seenToolCalls = new Set<string>();
	const seenToolResults = new Set<string>();
	const result: AcpRunResult = {
		ok: false,
		finalText: "",
		stderr: "",
		sessionId: null,
		stopReason: "",
		turns: 0,
		toolCalls: 0,
		toolResults: 0,
		permissionDenials: 0,
	};

	const child = new AcpChild(spec.command, spec.args, spec.env, cwd, {
		onNotification: (method, params) => {
			if (method !== "session/update") return;
			const update = objectOrEmpty(params["update"]);
			const kind = update["sessionUpdate"];
			if (kind === "agent_message_chunk") {
				const text = objectOrEmpty(update["content"])["text"];
				if (typeof text === "string") finalText += text;
				return;
			}
			if (kind === "tool_call") {
				const id = update["toolCallId"];
				if (typeof id === "string" && id.length > 0) {
					if (seenToolCalls.has(id)) return;
					seenToolCalls.add(id);
				}
				result.toolCalls += 1;
				const title =
					typeof update["title"] === "string" && update["title"].length > 0
						? update["title"]
						: typeof update["kind"] === "string"
							? update["kind"]
							: "tool";
				hooks.onAction?.(`→ ${title}`);
				return;
			}
			if (kind === "tool_call_update") {
				const status = update["status"];
				if (status !== "completed" && status !== "failed") return;
				const id = update["toolCallId"];
				if (typeof id === "string" && id.length > 0) {
					if (seenToolResults.has(id)) return;
					seenToolResults.add(id);
				}
				result.toolResults += 1;
				hooks.onAction?.(`← ${status === "failed" ? "result (error)" : "result"}`);
				return;
			}
			// plan, available_commands_update, user_message_chunk,
			// agent_thought_chunk, and other variants are ignored.
		},
		onRequest: (record) => {
			if (record["method"] !== "session/request_permission") return;
			const id = record["id"];
			if (typeof id !== "number") return;
			// Fail-closed: torus advertised no client capabilities, so nothing may
			// be approved on the user's behalf. The JSON-RPC result for the
			// request is the PermissionOutcome object itself.
			child.respond(id, { outcome: "cancelled" });
			result.permissionDenials += 1;
			const params = objectOrEmpty(record["params"]);
			const title =
				typeof params["title"] === "string" && params["title"].length > 0
					? params["title"]
					: "permission request";
			hooks.onAction?.(`! permission request denied (fail-closed): ${title}`);
		},
	});

	hooks.onControl?.({
		stop: () => {
			stopped = true;
			child.kill();
		},
	});

	const settle = (stopReason: string): AcpRunResult => {
		result.stopReason = stopReason;
		result.finalText = finalText;
		result.stderr = child.stderrText.slice(0, 2000);
		return result;
	};

	try {
		const init = await child.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "torus", version: torusVersion() },
			},
			HANDSHAKE_TIMEOUT_MS,
		);
		if (init["protocolVersion"] !== 1) {
			return settle(
				`acp ${name} answered protocolVersion ${String(init["protocolVersion"])}, torus requires 1`,
			);
		}
		const session = await child.request(
			"session/new",
			{ cwd, mcpServers: [] },
			HANDSHAKE_TIMEOUT_MS,
		);
		const sessionId = session["sessionId"];
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			return settle(`acp ${name} session/new returned no sessionId`);
		}
		result.sessionId = sessionId;
		hooks.onSession?.(sessionId);
		const prompt = await child.request(
			"session/prompt",
			{ sessionId, prompt: [{ type: "text", text: task }] },
			PROMPT_TIMEOUT_MS,
		);
		const stopReason = prompt["stopReason"];
		result.turns = finalText.length > 0 || result.toolCalls > 0 ? 1 : 0;
		if (stopReason !== "end_turn") {
			return settle(
				typeof stopReason === "string"
					? `stopReason ${stopReason}`
					: "prompt response without stopReason",
			);
		}
		if (finalText.length === 0 && result.toolCalls === 0) {
			return settle("end_turn with no output");
		}
		result.ok = true;
		return settle("end_turn");
	} catch (error) {
		return settle(
			stopped
				? `stopped: ${String(error).slice(0, 200)}`
				: `acp agent "${name}": ${String(error).slice(0, 300)}`,
		);
	} finally {
		child.kill();
	}
}

// ---------------------------------------------------------------------------
// AGENT role — `torus acp-agent`: serve torus to an ACP client (editors).
// ---------------------------------------------------------------------------

/** Pre-initialize session/* requests are refused LSP-style (ServerNotInitialized). */
const ACP_NOT_INITIALIZED = -32002;
const ACP_METHOD_NOT_FOUND = -32601;
const ACP_INVALID_PARAMS = -32602;
const ACP_INTERNAL_ERROR = -32603;

type AcpRequestId = number | string;

/** Terminal outcome of one in-flight session/prompt. */
type AcpPromptOutcome = { stopReason: "end_turn" | "cancelled" } | { failure: string };

interface AcpSessionState {
	sessionId: string;
	child: RpcChild;
	/** Session cwd from session/new params (defaults to the agent's cwd). */
	cwd: string;
	/** Counter for per-prompt-turn agent_message_chunk message ids. */
	nextMessage: number;
	currentMessageId: string;
	/** Resolves the in-flight session/prompt; null between prompts. */
	settle: ((outcome: AcpPromptOutcome) => void) | null;
	/** Set by session/cancel; the in-flight prompt then settles cancelled. */
	cancelled: boolean;
}

function sendJsonrpc(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyResult(id: AcpRequestId, result: Record<string, unknown>): void {
	sendJsonrpc({ jsonrpc: "2.0", id, result });
}

function replyError(id: AcpRequestId, code: number, message: string): void {
	sendJsonrpc({ jsonrpc: "2.0", id, error: { code, message } });
}

function notifySessionUpdate(state: AcpSessionState, update: Record<string, unknown>): void {
	sendJsonrpc({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: state.sessionId, update },
	});
}

/**
 * Translate one engine RPC event into ACP session/update notifications.
 * Assistant text deltas become agent_message_chunk (one messageId per prompt
 * turn); tool_execution_start announces a pending tool_call followed by an
 * in_progress update; tool_execution_end closes it completed (failed on
 * engine error). Every other engine event — session, message_start/end,
 * auto-retry, compaction — is omitted: the client sees the stream, not the
 * transcript.
 */
function emitAcpUpdates(state: AcpSessionState, event: Record<string, unknown>): void {
	if (event["type"] === "message_update") {
		const streamEvent = event["assistantMessageEvent"];
		if (
			typeof streamEvent === "object" &&
			streamEvent !== null &&
			(streamEvent as Record<string, unknown>)["type"] === "text_delta"
		) {
			const delta = (streamEvent as Record<string, unknown>)["delta"];
			if (typeof delta === "string" && delta.length > 0) {
				notifySessionUpdate(state, {
					sessionUpdate: "agent_message_chunk",
					messageId: state.currentMessageId,
					content: { type: "text", text: delta },
				});
			}
		}
		return;
	}
	if (event["type"] === "tool_execution_start") {
		const toolCallId = event["toolCallId"];
		if (typeof toolCallId !== "string" || toolCallId.length === 0) return;
		const title =
			typeof event["toolName"] === "string" && event["toolName"].length > 0
				? event["toolName"]
				: "tool";
		notifySessionUpdate(state, {
			sessionUpdate: "tool_call",
			toolCallId,
			title,
			kind: "other",
			status: "pending",
		});
		notifySessionUpdate(state, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "in_progress",
		});
		return;
	}
	if (event["type"] === "tool_execution_end") {
		const toolCallId = event["toolCallId"];
		if (typeof toolCallId !== "string" || toolCallId.length === 0) return;
		notifySessionUpdate(state, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: event["isError"] === true ? "failed" : "completed",
		});
	}
}

function acpPromptText(prompt: unknown): string {
	if (!Array.isArray(prompt)) return "";
	let text = "";
	for (const block of prompt) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b["type"] === "text" && typeof b["text"] === "string") text += b["text"];
	}
	return text;
}

function spawnAcpSession(cwd: string): AcpSessionState {
	const sessionId = `acp-${randomUUID()}`;
	let state!: AcpSessionState;
	// The minimal correct subset of the roster spawn: RPC mode plus the
	// canonical child extension set. No persona prompt file, no --model — the
	// editor drives the default torus engine; ACP carries no persona lever.
	const child = new RpcChild(
		resolveEngineBin(),
		["--mode", "rpc", ...childExtensionArgs(repoRoot())],
		cwd,
		{
			onEvent: (event) => emitAcpUpdates(state, event),
			onSettled: () => state.settle?.({ stopReason: state.cancelled ? "cancelled" : "end_turn" }),
		},
	);
	state = {
		sessionId,
		child,
		cwd,
		nextMessage: 1,
		currentMessageId: "torus-msg-0",
		settle: null,
		cancelled: false,
	};
	return state;
}

async function handleSessionPrompt(
	state: AcpSessionState,
	id: AcpRequestId,
	params: Record<string, unknown>,
): Promise<void> {
	if (state.settle !== null) {
		replyError(id, ACP_INVALID_PARAMS, `session/prompt already in flight for ${state.sessionId}`);
		return;
	}
	const task = acpPromptText(params["prompt"]);
	if (task.length === 0) {
		replyError(id, ACP_INVALID_PARAMS, "session/prompt carries no text blocks");
		return;
	}
	state.currentMessageId = `torus-msg-${state.nextMessage++}`;
	state.cancelled = false;
	const outcome = new Promise<AcpPromptOutcome>((resolve) => {
		state.settle = resolve;
	});
	try {
		// The engine acks the prompt command once preflight succeeds (well
		// before the run finishes — see its rpc-mode prompt handler); the run
		// itself settles via agent_settled below.
		await state.child.prompt(task);
	} catch (error) {
		state.settle = null;
		if (state.cancelled) {
			replyResult(id, { stopReason: "cancelled" });
			return;
		}
		replyError(
			id,
			ACP_INTERNAL_ERROR,
			`engine child failed before acknowledging the prompt: ${String(error).slice(0, 300)}`,
		);
		return;
	}
	const settled = await Promise.race([
		outcome,
		state.child.exited.then((code) => ({
			failure: `engine child exited (code ${code}) before the run settled`,
		})),
	]);
	state.settle = null;
	if (state.cancelled) {
		replyResult(id, { stopReason: "cancelled" });
		return;
	}
	if ("failure" in settled) {
		// No trailing agent_message_chunk: the JSON-RPC error is the whole
		// surface for a dead engine child — the client shows it verbatim.
		replyError(id, ACP_INTERNAL_ERROR, settled.failure);
		return;
	}
	replyResult(id, { stopReason: settled.stopReason });
}

/**
 * Serve the ACP v1 AGENT role on stdio (`torus acp-agent`): newline-delimited
 * JSON-RPC in on stdin, out on stdout — stdout is protocol-only, logs go to
 * stderr. Each session/new spawns a fresh headless engine child (one per ACP
 * session); session/prompt streams that child's events as session/update
 * notifications and resolves with the run's stopReason. Capability posture:
 * loadSession false (fresh child per session — session/load answers
 * method-not-found), promptCapabilities.embeddedContext false, no fs/terminal
 * (clientCapabilities from the editor govern; unimplemented methods answer
 * -32601), no mcpCapabilities (session/new mcpServers are ignored). Resolves
 * on stdin EOF after killing every engine child; called only by the launcher's
 * acp-agent interception, never inside an engine session.
 */
export async function runAcpAgentRole(): Promise<void> {
	let initialized = false;
	const sessions = new Map<string, AcpSessionState>();

	const killAll = (): void => {
		for (const state of sessions.values()) state.child.kill();
	};

	const handleAgentLine = (line: string): void => {
		if (!line.trim()) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return; // not JSON-RPC; ignore
		}
		if (typeof message !== "object" || message === null) return;
		const record = message as Record<string, unknown>;
		const method = record["method"];
		if (typeof method !== "string") return; // responses: torus sends none outbound
		const params = objectOrEmpty(record["params"]);
		const id = record["id"];
		const isRequest = typeof id === "number" || typeof id === "string";

		if (method === "initialize") {
			if (!isRequest) return;
			initialized = true;
			replyResult(id, {
				protocolVersion: 1,
				agentCapabilities: {
					loadSession: false,
					promptCapabilities: { embeddedContext: false },
				},
				agentInfo: { name: "torus", version: torusVersion(), title: "torus" },
				authMethods: [],
			});
			return;
		}

		// A notification at any time: cancellation kills the session's engine
		// child; the in-flight prompt (if any) settles cancelled.
		if (method === "session/cancel") {
			const sessionId = params["sessionId"];
			if (typeof sessionId !== "string") return;
			const state = sessions.get(sessionId);
			if (!state) return;
			state.cancelled = true;
			state.child.kill();
			return;
		}

		if (!isRequest) return; // other notifications: nothing to do

		if (!initialized && method.startsWith("session/")) {
			replyError(
				id,
				ACP_NOT_INITIALIZED,
				`session/* requests require initialize first (got ${method})`,
			);
			return;
		}

		switch (method) {
			case "session/new": {
				const cwd =
					typeof params["cwd"] === "string" && params["cwd"].length > 0
						? params["cwd"]
						: process.cwd();
				// mcpServers from the client are ignored: torus advertises no
				// mcpCapabilities, so a conforming client sends none.
				const state = spawnAcpSession(cwd);
				sessions.set(state.sessionId, state);
				replyResult(id, { sessionId: state.sessionId });
				return;
			}
			case "session/prompt": {
				const sessionId = params["sessionId"];
				const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
				if (!state) {
					replyError(
						id,
						ACP_INVALID_PARAMS,
						`session/prompt names unknown session ${String(sessionId)}`,
					);
					return;
				}
				void handleSessionPrompt(state, id, params).catch((error) => {
					replyError(
						id,
						ACP_INTERNAL_ERROR,
						`session/prompt failed: ${String(error).slice(0, 300)}`,
					);
				});
				return;
			}
			case "session/load":
				replyError(
					id,
					ACP_METHOD_NOT_FOUND,
					"session/load is not implemented: torus spawns a fresh engine child per session (loadSession: false)",
				);
				return;
			default:
				replyError(
					id,
					ACP_METHOD_NOT_FOUND,
					`torus does not implement ${method} (capability-gated off at initialize)`,
				);
		}
	};

	const onSignal = (): void => {
		killAll();
		process.exit(0);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const done = new Promise<void>((resolve) => {
		process.stdin.on("end", () => resolve());
		process.stdin.on("close", () => resolve());
		process.stdin.on("error", () => resolve());
	});

	const decoder = new StringDecoder("utf8");
	let buffer = "";
	process.stdin.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		if (buffer.length > LINE_CAP) buffer = buffer.slice(-LINE_CAP);
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			handleAgentLine(line);
			newline = buffer.indexOf("\n");
		}
	});

	await done;
	// EOF is the documented shutdown: kill every engine child, then let the
	// process exit on its own (SIGKILL stragglers after a grace period).
	killAll();
	const deadline = new Promise<void>((resolve) => {
		setTimeout(resolve, 2000).unref();
	});
	await Promise.race([Promise.all([...sessions.values()].map((s) => s.child.exited)), deadline]);
	for (const state of sessions.values()) state.child.kill("SIGKILL");
}

export default function acpExtension(_pi: ExtensionAPI): void {
	// No runtime registration: roster imports the config and transport helpers
	// directly. Loading this module as an extension keeps the ACP consume
	// surface versioned with the rest of the payload.
}
