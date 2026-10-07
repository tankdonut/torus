/**
 * torus — shared engine-child plumbing.
 *
 * The delegation path (roster, JSON + RPC modes) and the team supervisor
 * (team-runtime) both spawn the pi engine as a child and consume its event
 * stream; these helpers centralize the duplicated pieces of that protocol.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./registry.js";

/**
 * Environment for spawned engine children. Sets TORUS_ENGINE_CHILD so
 * parent-only extensions (worktree lifecycle tools) skip registration in
 * delegation and team-member sessions.
 */
export function engineChildEnv(): NodeJS.ProcessEnv {
	return { ...process.env, TORUS_ENGINE_CHILD: "1" };
}

/** Parse one JSONL event line; non-object or unparseable input yields null. */
export function parseEngineEvent(line: string): Record<string, unknown> | null {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof event !== "object" || event === null) return null;
	return event as Record<string, unknown>;
}

/** Running tally maintained by reduceEngineEvent across an engine session. */
export interface EngineTally {
	turns: number;
	tokensIn: number;
	tokensOut: number;
	/** Prompt-cache tokens read across the session (usage.cacheRead). */
	cacheRead: number;
	/** Prompt-cache tokens written across the session (usage.cacheWrite). */
	cacheWrite: number;
	/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
	cost: number;
	text: string;
	/**
	 * Consecutive trailing assistant turns that added neither a token delta
	 * nor a text change — the defensive net for dead model connections the
	 * engine never signals explicitly. Failed calls still emit message_end
	 * (and may finalize cleanly). Reset to 0 by any turn that progresses;
	 * optional so pre-existing tallies start at 0.
	 */
	noProgressTail?: number;
	/**
	 * Most recent engine-signaled model-error text: an `error` stream event,
	 * an assistant message_end with stopReason "error" (its errorMessage), or
	 * an exhausted auto-retry (auto_retry_end success:false, its finalError).
	 * Most recent wins; a later healthy assistant turn clears it — the
	 * engine's own auto-retry recovered — so it tracks the run's trailing
	 * failure state, not its history. Optional so pre-existing tallies start
	 * with none.
	 */
	lastError?: string;
}

/** Add a usage value into a running counter; absent/non-finite values read as 0. */
function sumFinite(current: unknown, delta: unknown): number {
	const base = typeof current === "number" && Number.isFinite(current) ? current : 0;
	const add = typeof delta === "number" && Number.isFinite(delta) ? delta : 0;
	return base + add;
}

/** First non-empty trimmed string among the candidates, or null. */
function errorText(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

/**
 * Fold a `message_end` assistant event into `tally`: each text block sets
 * `tally.text` and counts a turn (roster semantics — final text wins), and a
 * numeric usage object adds to the token counters, the cache counters, and
 * the engine-computed cost. Non-matching events are ignored. Absent or
 * non-finite usage values accumulate as 0 so the tally can never go NaN.
 *
 * Engine-signaled model errors are consumed in the same fold — the single
 * pipeline: an `error` stream event, a message_update carrying one, an
 * assistant message_end with stopReason "error", or auto_retry_end with
 * success:false all record their text in `tally.lastError` (most recent wins;
 * a later healthy turn clears it). Per-turn progress is measured here too: a
 * turn whose token totals and text are both unchanged made no progress and
 * extends `tally.noProgressTail` — the defensive net for error shapes the
 * engine never signals; any delta (tokens or text) resets it to 0.
 */
export function reduceEngineEvent(record: Record<string, unknown>, tally: EngineTally): void {
	if (record["type"] === "error") {
		tally.lastError = errorText(record["error"], record["reason"]) ?? "provider stream error";
		return;
	}
	if (record["type"] === "auto_retry_end" && record["success"] === false) {
		tally.lastError = errorText(record["finalError"]) ?? "engine auto-retry failed";
		return;
	}
	if (record["type"] === "message_update") {
		const streamEvent = record["assistantMessageEvent"];
		if (
			typeof streamEvent === "object" &&
			streamEvent !== null &&
			(streamEvent as Record<string, unknown>)["type"] === "error"
		) {
			const e = streamEvent as Record<string, unknown>;
			tally.lastError =
				errorText(e["errorMessage"], e["error"], e["reason"]) ?? "provider stream error";
		}
		return;
	}
	if (
		record["type"] !== "message_end" ||
		typeof record["message"] !== "object" ||
		record["message"] === null
	)
		return;
	const message = record["message"] as Record<string, unknown>;
	if (message["role"] !== "assistant") return;
	const stopReason = message["stopReason"];
	// The stopReason gate sits ahead of the content guard so an error signal
	// never depends on the message carrying well-formed content blocks.
	if (stopReason === "error") {
		tally.lastError =
			errorText(message["errorMessage"]) ??
			tally.lastError ??
			"model call failed (stopReason: error)";
	} else if (
		stopReason === "stop" ||
		stopReason === "toolUse" ||
		stopReason === "length" ||
		stopReason === "deferred"
	) {
		tally.lastError = undefined;
	}
	const content = message["content"];
	if (!Array.isArray(content)) return;
	const tokensBefore = tally.tokensIn + tally.tokensOut;
	const textBefore = tally.text;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b["type"] === "text" && typeof b["text"] === "string") {
			tally.text = b["text"];
		}
	}
	tally.turns += 1;
	const usage = message["usage"];
	if (typeof usage === "object" && usage !== null) {
		const u = usage as Record<string, unknown>;
		tally.tokensIn += typeof u["input"] === "number" ? u["input"] : 0;
		tally.tokensOut += typeof u["output"] === "number" ? u["output"] : 0;
		tally.cacheRead = sumFinite(tally.cacheRead, u["cacheRead"]);
		tally.cacheWrite = sumFinite(tally.cacheWrite, u["cacheWrite"]);
		const cost = u["cost"];
		const costTotal =
			typeof cost === "object" && cost !== null
				? (cost as Record<string, unknown>)["total"]
				: undefined;
		tally.cost = sumFinite(tally.cost, costTotal);
	}
	const progressed = tally.tokensIn + tally.tokensOut !== tokensBefore || tally.text !== textBefore;
	tally.noProgressTail = progressed ? 0 : (tally.noProgressTail ?? 0) + 1;
}

/** The canonical `--extension` argument list every torus child engine gets. */
export function childExtensionArgs(root: string): string[] {
	return [
		"--extension",
		path.join(root, "extensions", "mcp", "index.ts"),
		"--extension",
		path.join(root, "extensions", "comment-checker", "index.ts"),
		"--extension",
		path.join(root, "extensions", "hashline", "index.ts"),
		"--extension",
		path.join(root, "extensions", "vision", "index.ts"),
		"--extension",
		path.join(root, "extensions", "guards", "index.ts"),
		"--extension",
		path.join(root, "extensions", "astgrep", "index.ts"),
		"--extension",
		path.join(root, "extensions", "sessions", "index.ts"),
		"--extension",
		path.join(root, "extensions", "work", "index.ts"),
		"--extension",
		path.join(root, "node_modules", "cc-safety-net", "dist", "pi", "index.js"),
		"--extension",
		path.join(root, "node_modules", "pi-web-access", "dist"),
		"--extension",
		path.join(root, "node_modules", "pi-lsp-client", "src", "index.ts"),
	];
}

/**
 * Resolve the engine binary: TORUS_ENGINE_BIN wins, then the repo-local
 * node_modules/.bin/pi, then whatever is on PATH.
 */
export function resolveEngineBin(): string {
	const fromEnv = process.env["TORUS_ENGINE_BIN"];
	if (fromEnv) return fromEnv;
	const local = path.join(repoRoot(), "node_modules", ".bin", "pi");
	if (existsSync(local)) return local;
	return "pi";
}

/** Extract data.sessionId from a get_state RPC response, if present. */
export function sessionIdFromState(state: Record<string, unknown>): string | null {
	const data = state["data"];
	if (typeof data !== "object" || data === null) return null;
	const sessionId = (data as Record<string, unknown>)["sessionId"];
	return typeof sessionId === "string" ? sessionId : null;
}
