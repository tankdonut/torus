import { readdirSync, readFileSync, statSync } from "node:fs";
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

interface TranscriptCache {
	mtimeMs: number;
	items: TranscriptItem[];
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

/** mtime of the most recently parsed transcript for a session, for component-cache staleness checks. */
export function transcriptMtimeMs(sessionId: string): number | undefined {
	return transcriptCacheGet(sessionId)?.mtimeMs;
}

function findSessionFile(sessionId: string): string | null {
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

export function liveTail(logFile: string, maxLines: number): string[] {
	let raw: string;
	try {
		raw = readFileSync(logFile, "utf8");
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
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return [];
	}
	const cached = transcriptCacheGet(sessionId);
	if (cached && cached.mtimeMs === mtimeMs) return cached.items.slice(-maxItems);

	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return cached?.items.slice(-maxItems) ?? [];
	}

	const items: TranscriptItem[] = [];
	let counter = 0;
	const nextId = () => `${counter++}`;

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record["type"] !== "message") continue;
		const message = record["message"] as Record<string, unknown> | undefined;
		if (!message || typeof message["role"] !== "string") continue;
		const role = message["role"];
		const content = message["content"];

		if (role === "user") {
			const text = textBlocks(content).join("\n");
			if (text.length > 0) items.push({ kind: "user", id: nextId(), text });
		} else if (role === "assistant") {
			items.push({
				kind: "assistant",
				id: nextId(),
				message: message as unknown as AssistantMessageLike,
			});
			if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block !== "object" || block === null) continue;
					const b = block as Record<string, unknown>;
					if (b["type"] === "toolCall" && typeof b["name"] === "string") {
						items.push({
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
			const target = toolCallId
				? [...items]
						.reverse()
						.find((item) => item.kind === "tool" && item.toolCallId === toolCallId)
				: [...items].reverse().find((item) => item.kind === "tool" && item.output === undefined);
			if (target && target.kind === "tool") {
				target.output = output;
				target.isError = isError;
				if (details !== undefined) target.details = details;
			}
		}
	}

	transcriptCachePut(sessionId, { mtimeMs, items });
	return items.slice(-maxItems);
}
