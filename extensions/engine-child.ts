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
}

/** Add a usage value into a running counter; absent/non-finite values read as 0. */
function sumFinite(current: unknown, delta: unknown): number {
	const base = typeof current === "number" && Number.isFinite(current) ? current : 0;
	const add = typeof delta === "number" && Number.isFinite(delta) ? delta : 0;
	return base + add;
}

/**
 * Fold a `message_end` assistant event into `tally`: each text block sets
 * `tally.text` and counts a turn (roster semantics — final text wins), and a
 * numeric usage object adds to the token counters, the cache counters, and
 * the engine-computed cost. Non-matching events are ignored. Absent or
 * non-finite usage values accumulate as 0 so the tally can never go NaN.
 */
export function reduceEngineEvent(record: Record<string, unknown>, tally: EngineTally): void {
	if (
		record["type"] !== "message_end" ||
		typeof record["message"] !== "object" ||
		record["message"] === null
	)
		return;
	const message = record["message"] as Record<string, unknown>;
	if (message["role"] !== "assistant") return;
	const content = message["content"];
	if (!Array.isArray(content)) return;
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
