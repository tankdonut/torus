/**
 * torus — session search (tool form).
 *
 * pi's /resume lists sessions per cwd; this greps INSIDE session files so
 * "which session fixed the mailbox cursors" is answerable directly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_ROOT = path.join(homedir(), ".pi", "agent", "sessions");
const SCAN_LIMIT = 300;

export interface SessionHit {
	file: string;
	sessionId: string;
	when: string;
	project: string;
	snippet: string;
}

export function searchSessions(query: string, root: string, limit: number): SessionHit[] {
	const needle = query.toLowerCase();
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
			let raw: string;
			try {
				raw = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			if (!raw.toLowerCase().includes(needle)) continue;
			const line = raw.split("\n").find((candidate) => candidate.toLowerCase().includes(needle));
			const snippet = (line ?? "")
				.slice(Math.max(0, (line ?? "").toLowerCase().indexOf(needle) - 60), 220)
				.replace(/\s+/g, " ");
			hits.push({
				file: full,
				sessionId: /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? file,
				when: /^\d{4}-\d{2}-\d{2}T[\d-]+/.exec(file)?.[0] ?? "unknown",
				project: path.basename(dir),
				snippet,
			});
			if (hits.length >= limit) return hits;
		}
	}
	return hits;
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
		const hits = searchSessions(params.query, DEFAULT_ROOT, params.limit ?? 8);
		if (hits.length === 0) {
			return {
				content: [{ type: "text", text: `no sessions match "${params.query}"` }],
				details: { hits: 0 },
			};
		}
		const text = hits
			.map((hit) => `${hit.when} · ${hit.project} · ${hit.sessionId}\n  ${hit.snippet}`)
			.join("\n\n");
		return { content: [{ type: "text", text }], details: { hits: hits.length } };
	},
});

export function registerSessions(pi: ExtensionAPI): void {
	pi.registerTool(sessionsTool);
}

export default function sessionsExtension(pi: ExtensionAPI): void {
	registerSessions(pi);
}
