import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

export type AssistantMessageLike = ConstructorParameters<typeof AssistantMessageComponent>[0];

export type TranscriptItem =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; message: AssistantMessageLike }
	| {
			kind: "tool";
			id: string;
			toolCallId: string;
			name: string;
			args: unknown;
			output?: string;
			isError?: boolean;
			/** Structured result payload (e.g. an edit's diff) — tool renderers key on it. */
			details?: unknown;
	  };

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

interface TranscriptCache {
	mtimeMs: number;
	size: number;
	items: TranscriptItem[];
	/** Bytes consumed: the position just past the last complete line. Bytes after
	 * this point belong to a not-yet-terminated line and are re-read on the next
	 * append, so a torn UTF-8 tail heals itself instead of corrupting the cache. */
	byteOffset: number;
	/** The trailing line currently missing its newline; informational. */
	partialLine: string;
	toolByCallId: Map<string, ToolItem>;
	/** Tool calls still awaiting a result, keyed by item id (insertion-ordered). */
	openTools: Map<string, ToolItem>;
	/** Next item id; appends must continue the sequence so component-cache keys
	 * never collide with ids minted by the earlier full parse. */
	counter: number;
}

/** Parse state shared by the full and incremental paths. */
interface ParseState {
	items: TranscriptItem[];
	counter: number;
	toolByCallId: Map<string, ToolItem>;
	openTools: Map<string, ToolItem>;
}

const SESSION_ROOTS = [
	...(process.env["PI_CODING_AGENT_SESSION_DIR"]
		? [process.env["PI_CODING_AGENT_SESSION_DIR"]]
		: []),
	...(process.env["PI_CODING_AGENT_DIR"]
		? [path.join(process.env["PI_CODING_AGENT_DIR"], "sessions")]
		: []),
	path.join(homedir(), ".pi", "agent", "sessions"),
];

const TRANSCRIPT_CACHE_LIMIT = 16;
const transcriptCache = new Map<string, TranscriptCache>();

/** Test-only counters: lines fed through the parser and full reparse passes. */
const transcriptStats = { linesParsed: 0, fullReparses: 0 };

export function _transcriptStats(): { linesParsed: number; fullReparses: number } {
	return { ...transcriptStats };
}

/** LRU access: re-insert on read so recently viewed sessions survive eviction. */
function transcriptCacheGet(sessionId: string): TranscriptCache | undefined {
	const cached = transcriptCache.get(sessionId);
	if (cached) {
		transcriptCache.delete(sessionId);
		transcriptCache.set(sessionId, cached);
	}
	return cached;
}

function transcriptCachePut(sessionId: string, value: TranscriptCache): void {
	transcriptCache.delete(sessionId);
	transcriptCache.set(sessionId, value);
	while (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
		const oldest = transcriptCache.keys().next().value;
		if (oldest === undefined) break;
		transcriptCache.delete(oldest);
	}
}

/** mtime of the most recently parsed transcript for a session. */
export function transcriptMtimeMs(sessionId: string): number | undefined {
	return transcriptCacheGet(sessionId)?.mtimeMs;
}

const sessionFileMemo = new Map<string, string>();

function findSessionFile(sessionId: string): string | null {
	const memoized = sessionFileMemo.get(sessionId);
	if (memoized !== undefined) {
		try {
			statSync(memoized);
			return memoized;
		} catch {
			sessionFileMemo.delete(sessionId);
		}
	}
	for (const root of SESSION_ROOTS) {
		const candidates: string[] = [];
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					try {
						for (const file of readdirSync(path.join(root, entry.name))) {
							if (file.endsWith(`_${sessionId}.jsonl`) || file === `${sessionId}.jsonl`) {
								candidates.push(path.join(root, entry.name, file));
							}
						}
					} catch {}
				} else if (
					entry.name.endsWith(`_${sessionId}.jsonl`) ||
					entry.name === `${sessionId}.jsonl`
				) {
					candidates.push(path.join(root, entry.name));
				}
			}
		} catch {
			continue;
		}
		for (const candidate of candidates) {
			try {
				statSync(candidate);
				sessionFileMemo.set(sessionId, candidate);
				return candidate;
			} catch {}
		}
	}
	return null;
}

function textBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as Record<string, unknown>)["type"] === "text" &&
			typeof (block as Record<string, unknown>)["text"] === "string"
		) {
			const text = (block as Record<string, unknown>)["text"] as string;
			if (text.trim().length > 0) texts.push(text);
		}
	}
	return texts;
}

/** The most recent tool call still lacking a result — the same record the old
 * reverse scan over every item landed on, derived from the open-tool map. */
function lastOpenTool(state: ParseState): ToolItem | undefined {
	let last: ToolItem | undefined;
	for (const tool of state.openTools.values()) last = tool;
	return last;
}

function pushTool(state: ParseState, item: ToolItem): void {
	state.items.push(item);
	state.toolByCallId.set(item.toolCallId, item);
	state.openTools.set(item.id, item);
}

function parseLine(line: string, state: ParseState): void {
	if (!line.trim()) return;
	transcriptStats.linesParsed += 1;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof entry !== "object" || entry === null) return;
	const record = entry as Record<string, unknown>;
	const nextId = () => `${state.counter++}`;

	// Custom entries are per-session mirrors of extension state. Only
	// torus.work-ledger rows render — the ledger JSONL file under
	// $TORUS_STATE_DIR/work stays the cross-session source of truth; the mirrored
	// entry just makes the row visible in this session's replay. Rendered
	// through the tool-item pipeline so it draws as a compact ledger line;
	// every other custom entry is ignored.
	if (record["type"] === "custom") {
		if (record["customType"] === "torus.work-ledger") {
			const data = record["data"];
			if (typeof data === "object" && data !== null) {
				const row = data as Record<string, unknown>;
				const event = typeof row["event"] === "string" ? row["event"] : "?";
				const text = typeof row["text"] === "string" ? row["text"] : "";
				const id = nextId();
				pushTool(state, {
					kind: "tool",
					id,
					toolCallId: `ledger-${id}`,
					name: "ledger",
					args: { event, text: text.slice(0, 120) },
				});
			}
		}
		return;
	}
	if (record["type"] !== "message") return;
	const message = record["message"] as Record<string, unknown> | undefined;
	if (!message || typeof message["role"] !== "string") return;
	const role = message["role"];
	const content = message["content"];

	if (role === "user") {
		const text = textBlocks(content).join("\n");
		if (text.length > 0) state.items.push({ kind: "user", id: nextId(), text });
	} else if (role === "assistant") {
		state.items.push({
			kind: "assistant",
			id: nextId(),
			message: message as unknown as AssistantMessageLike,
		});
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block !== "object" || block === null) continue;
				const b = block as Record<string, unknown>;
				if (b["type"] === "toolCall" && typeof b["name"] === "string") {
					pushTool(state, {
						kind: "tool",
						id: nextId(),
						toolCallId: typeof b["id"] === "string" ? b["id"] : nextId(),
						name: b["name"] as string,
						args: b["arguments"],
					});
				}
			}
		}
	} else if (role === "toolResult") {
		const output = textBlocks(content).join("\n");
		const isError = message["isError"] === true;
		const details = message["details"];
		const toolCallId =
			typeof message["toolCallId"] === "string" ? message["toolCallId"] : undefined;
		const target = toolCallId ? state.toolByCallId.get(toolCallId) : lastOpenTool(state);
		if (target) {
			target.output = output;
			target.isError = isError;
			if (details !== undefined) target.details = details;
			state.openTools.delete(target.id);
		}
	}
}

/** Parse the appended tail onto a cached entry. Returns false when the read
 * fails and the caller should fall back to a full reparse. */
function parseAppended(
	file: string,
	size: number,
	mtimeMs: number,
	cached: TranscriptCache,
): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const length = size - cached.byteOffset;
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, cached.byteOffset + read);
			if (n === 0) break;
			read += n;
		}
		const lastNewline = buffer.subarray(0, read).lastIndexOf(0x0a);
		if (lastNewline >= 0) {
			const chunk = buffer.subarray(0, lastNewline).toString("utf8");
			const state: ParseState = {
				items: cached.items,
				counter: cached.counter,
				toolByCallId: cached.toolByCallId,
				openTools: cached.openTools,
			};
			for (const line of chunk.split("\n")) parseLine(line, state);
			cached.counter = state.counter;
			cached.byteOffset += lastNewline + 1;
		}
		cached.partialLine = buffer.subarray(lastNewline + 1, read).toString("utf8");
		cached.mtimeMs = mtimeMs;
		cached.size = cached.byteOffset + (read - lastNewline - 1);
		return true;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

const TAIL_WINDOW_BYTES = 256 * 1024;

export function liveTail(logFile: string, maxLines: number): string[] {
	let raw: string;
	try {
		const stats = statSync(logFile);
		// Only the tail window matters for last-N rendering; skip re-reading
		// megabytes of log on every 80ms fleet tick.
		if (stats.size > TAIL_WINDOW_BYTES) {
			const fd = openSync(logFile, "r");
			try {
				const buffer = Buffer.alloc(TAIL_WINDOW_BYTES);
				let read = 0;
				while (read < TAIL_WINDOW_BYTES) {
					const n = readSync(
						fd,
						buffer,
						read,
						TAIL_WINDOW_BYTES - read,
						stats.size - TAIL_WINDOW_BYTES + read,
					);
					if (n === 0) break;
					read += n;
				}
				raw = buffer.subarray(0, read).toString("utf8");
			} finally {
				closeSync(fd);
			}
			const firstNewline = raw.indexOf("\n");
			if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
		} else {
			raw = readFileSync(logFile, "utf8");
		}
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(-maxLines);
}

export function transcriptItems(sessionId: string, maxItems: number): TranscriptItem[] {
	const file = findSessionFile(sessionId);
	if (!file) return [];
	const stats = (() => {
		try {
			return statSync(file);
		} catch {
			return null;
		}
	})();
	if (!stats) return [];
	const cached = transcriptCacheGet(sessionId);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
		return cached.items.slice(-maxItems);
	}
	// Grew: parse only the appended bytes onto the cached items. Anything else
	// (shrink, or content rewritten at the same size) re-parses in full —
	// correctness over cleverness for the rare non-append mutation.
	if (
		cached &&
		stats.size > cached.size &&
		parseAppended(file, stats.size, stats.mtimeMs, cached)
	) {
		return cached.items.slice(-maxItems);
	}

	let raw: Buffer;
	try {
		raw = readFileSync(file);
	} catch {
		return cached?.items.slice(-maxItems) ?? [];
	}
	transcriptStats.fullReparses += 1;
	const state: ParseState = {
		items: [],
		counter: 0,
		toolByCallId: new Map(),
		openTools: new Map(),
	};
	const text = raw.toString("utf8");
	// Only complete lines render; a trailing write without its newline is held
	// as the partial and picked up once the writer terminates the line.
	const lastNewline = raw.lastIndexOf(0x0a);
	const chunk = lastNewline >= 0 ? raw.subarray(0, lastNewline).toString("utf8") : "";
	for (const line of chunk.split("\n")) parseLine(line, state);
	transcriptCachePut(sessionId, {
		mtimeMs: stats.mtimeMs,
		size: raw.length,
		items: state.items,
		byteOffset: lastNewline + 1,
		partialLine: lastNewline >= 0 ? text.slice(text.lastIndexOf("\n") + 1) : text,
		toolByCallId: state.toolByCallId,
		openTools: state.openTools,
		counter: state.counter,
	});
	return state.items.slice(-maxItems);
}
