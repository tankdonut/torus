/**
 * torus — session search (tool form).
 *
 * pi's /resume lists sessions per cwd; this greps INSIDE session files so
 * "which session fixed the mailbox cursors" is answerable directly.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gateExtension, type PlatformSupport } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

const DEFAULT_ROOT = path.join(homedir(), ".pi", "agent", "sessions");
const SCAN_LIMIT = 300;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export interface SessionHit {
	file: string;
	sessionId: string;
	when: string;
	project: string;
	snippet: string;
}

/** Scan bookkeeping for callers that surface it (the tool's result note). */
export interface SessionScanStats {
	skippedOversized: number;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Snippet for the first line that matches `needle`, or null when nothing in
 * `raw` matches. One case-insensitive scan of the whole text gates the file;
 * only then are line boundaries resolved around the first in-line match. A
 * query that only matches across newlines yields an empty snippet (legacy
 * `split("\n").find` behavior — the hit still counts).
 */
function snippetFor(needle: RegExp, raw: string): string | null {
	needle.lastIndex = 0;
	if (!needle.test(raw)) {
		return null;
	}
	needle.lastIndex = 0;
	for (let match = needle.exec(raw); match !== null; match = needle.exec(raw)) {
		if (match[0].includes("\n")) continue;
		const lineStart = raw.lastIndexOf("\n", match.index) + 1;
		const lineEnd = raw.indexOf("\n", match.index);
		const line = raw.slice(lineStart, lineEnd === -1 ? raw.length : lineEnd);
		const indexInLine = match.index - lineStart;
		needle.lastIndex = 0;
		return line.slice(Math.max(0, indexInLine - 60), 220).replace(/\s+/g, " ");
	}
	needle.lastIndex = 0;
	return "";
}

export function searchSessions(
	query: string,
	root: string,
	limit: number,
	stats?: SessionScanStats,
): SessionHit[] {
	const needle = new RegExp(escapeRegExp(query), "gi");
	const dirs: Array<{ dir: string; mtimeMs: number }> = [];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			try {
				dirs.push({ dir, mtimeMs: statSync(dir).mtimeMs });
			} catch {}
		}
	} catch {
		return [];
	}
	dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const hits: SessionHit[] = [];
	for (const { dir } of dirs.slice(0, SCAN_LIMIT)) {
		let files: string[];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const full = path.join(dir, file);
			try {
				if (statSync(full).size > MAX_TRANSCRIPT_BYTES) {
					if (stats) stats.skippedOversized += 1;
					continue;
				}
				const raw = readFileSync(full, "utf8");
				const snippet = snippetFor(needle, raw);
				if (snippet === null) continue;
				hits.push({
					file: full,
					sessionId: /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? file,
					when: /^\d{4}-\d{2}-\d{2}T[\d-]+/.exec(file)?.[0] ?? "unknown",
					project: path.basename(dir),
					snippet,
				});
				if (hits.length >= limit) return hits;
			} catch {}
		}
	}
	return hits;
}

/** Locate the transcript file for a session id (uuid-suffix match) under root. */
export function findSessionFile(sessionId: string, root: string = DEFAULT_ROOT): string | null {
	const suffix = `_${sessionId}.jsonl`;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			try {
				const hit = readdirSync(dir).find((file) => file.endsWith(suffix));
				if (hit) return path.join(dir, hit);
			} catch {}
		}
	} catch {}
	return null;
}

/**
 * Memoized one-level listing of a sessions root: every session id a file
 * there can answer (`<ts>_<sessionId>.jsonl` in root or a project subdir,
 * plus the bare `<sessionId>.jsonl` stem). Keyed by the root's mtime so new
 * project dirs invalidate it; a TTL caps staleness for roots whose mtime
 * never changes (new transcripts inside an existing project dir).
 */
type SessionIndexEntry = { mtimeMs: number; builtAtMs: number; ids: Set<string> };

const SESSION_INDEX_TTL_MS = 30_000;
const SESSION_INDEX_MAX_ROOTS = 32;
const sessionIndexCache = new Map<string, SessionIndexEntry>();

/** Directory listings the memo has performed since process start (test-only). */
let sessionDirListings = 0;

/** Test-only: listing counter, for asserting the memo absorbs repeat lookups. */
export function _sessionsStats(): { dirListings: number } {
	return { dirListings: sessionDirListings };
}

/** Record every id `file` can answer: `_<id>.jsonl` suffixes plus the bare stem. */
function indexSessionFile(ids: Set<string>, file: string): void {
	if (!file.endsWith(".jsonl")) return;
	const stem = file.slice(0, -".jsonl".length);
	ids.add(stem);
	for (let i = stem.indexOf("_"); i !== -1; i = stem.indexOf("_", i + 1)) {
		ids.add(stem.slice(i + 1));
	}
}

function buildSessionIndex(root: string, mtimeMs: number): SessionIndexEntry | null {
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
		sessionDirListings += 1;
	} catch {
		return null;
	}
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			indexSessionFile(ids, entry.name);
			continue;
		}
		try {
			for (const name of readdirSync(path.join(root, entry.name))) {
				indexSessionFile(ids, name);
			}
			sessionDirListings += 1;
		} catch {}
	}
	return { mtimeMs, builtAtMs: Date.now(), ids };
}

function sessionIndexFor(root: string): SessionIndexEntry | null {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(root).mtimeMs;
	} catch {
		sessionIndexCache.delete(root);
		return null;
	}
	const cached = sessionIndexCache.get(root);
	if (
		cached &&
		cached.mtimeMs === mtimeMs &&
		Date.now() - cached.builtAtMs < SESSION_INDEX_TTL_MS
	) {
		return cached;
	}
	const entry = buildSessionIndex(root, mtimeMs);
	if (!entry) return null;
	if (!sessionIndexCache.has(root) && sessionIndexCache.size >= SESSION_INDEX_MAX_ROOTS) {
		const oldest = sessionIndexCache.keys().next().value;
		if (oldest !== undefined) sessionIndexCache.delete(oldest);
	}
	sessionIndexCache.set(root, entry);
	return entry;
}

/**
 * Does any session file for `sessionId` exist under `root`? `null` means the
 * root is unreadable — callers must prune nothing in that case. Sessions are
 * resumable indefinitely, so `true` must keep a session's satellite state
 * forever. Lookups are served from the memoized root index.
 */
export function sessionFileExists(sessionId: string, root: string = DEFAULT_ROOT): boolean | null {
	const index = sessionIndexFor(root);
	return index ? index.ids.has(sessionId) : null;
}

const sessionsTool = defineTool({
	name: "torus_sessions",
	label: "Torus Sessions",
	description:
		"Search past pi sessions by content (inside the transcripts, not just filenames). Returns session id, date, project dir, and a matching snippet for each hit — resume with pi's /resume or `pi --session-id <id>`.",
	parameters: Type.Object({
		query: Type.String({ description: "Text to find inside session transcripts" }),
		limit: Type.Optional(
			Type.Number({ minimum: 1, maximum: 20, description: "Max hits (default 8)" }),
		),
	}),
	async execute(_toolCallId, params) {
		const stats: SessionScanStats = { skippedOversized: 0 };
		const hits = searchSessions(params.query, DEFAULT_ROOT, params.limit ?? 8, stats);
		const details: { hits: number; note?: string } = { hits: hits.length };
		if (stats.skippedOversized > 0) {
			details.note = `skipped ${stats.skippedOversized} oversized transcripts`;
		}
		if (hits.length === 0) {
			return {
				content: [{ type: "text", text: `no sessions match "${params.query}"` }],
				details,
			};
		}
		const text = hits
			.map((hit) => `${hit.when} · ${hit.project} · ${hit.sessionId}\n  ${hit.snippet}`)
			.join("\n\n");
		return { content: [{ type: "text", text }], details };
	},
});

export function registerSessions(pi: ExtensionAPI): void {
	pi.registerTool(sessionsTool);
}

export default function sessionsExtension(pi: ExtensionAPI): void {
	if (!gateExtension("sessions", PLATFORM_SUPPORT)) return;
	registerSessions(pi);
}
