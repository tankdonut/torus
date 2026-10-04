import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const STASH_LIMIT = 50;

const LINE_COMMENT_PREFIXES: Record<string, readonly string[]> = {
	".ts": ["//"],
	".tsx": ["//"],
	".js": ["//"],
	".mjs": ["//"],
	".cjs": ["//"],
	".jsx": ["//"],
	".jsonc": ["//"],
	".java": ["//"],
	".c": ["//"],
	".h": ["//"],
	".cc": ["//"],
	".cpp": ["//"],
	".hpp": ["//"],
	".cs": ["//"],
	".go": ["//"],
	".rs": ["//"],
	".swift": ["//"],
	".kt": ["//"],
	".scala": ["//"],
	".zig": ["//"],
	".py": ["#"],
	".pyi": ["#"],
	".sh": ["#"],
	".bash": ["#"],
	".zsh": ["#"],
	".yaml": ["#"],
	".yml": ["#"],
	".toml": ["#"],
	".rb": ["#"],
	".pl": ["#"],
	".r": ["#"],
	".sql": ["--"],
	".lua": ["--"],
	".hs": ["--"],
	".elm": ["--"],
	".vim": ['"'],
	".lisp": [";"],
	".clj": [";"],
	".el": [";"],
	".asm": [";"],
	".ini": [";", "#"],
	".conf": [";", "#"],
	".html": ["<!--"],
	".xml": ["<!--"],
	".svg": ["<!--"],
	".md": ["<!--"],
	".css": ["/*"],
	".scss": ["/*"],
	".less": ["/*"],
};

export function commentPrefixesFor(file: string): readonly string[] {
	return LINE_COMMENT_PREFIXES[path.extname(file).toLowerCase()] ?? [];
}

export function addedLinesForEdit(edits: Array<{ oldText: string; newText: string }>): string[] {
	const removed = new Set<string>();
	for (const edit of edits) {
		for (const line of edit.oldText.split("\n")) removed.add(line.trim());
	}
	const added: string[] = [];
	for (const edit of edits) {
		for (const line of edit.newText.split("\n")) {
			if (!removed.has(line.trim())) added.push(line);
		}
	}
	return added;
}

export function addedLinesForWrite(content: string, disk: string | null): string[] {
	const lines = content.split("\n");
	if (disk === null) return [...lines];
	const existing = new Set(disk.split("\n").map((line) => line.trim()));
	return lines.filter((line) => !existing.has(line.trim()));
}

export function findCommentedLines(lines: string[], file: string): string[] {
	const prefixes = commentPrefixesFor(file);
	if (prefixes.length === 0) return [];
	return lines.filter((line) => {
		const trimmed = line.trimStart();
		for (const prefix of prefixes) {
			if (trimmed.startsWith(prefix)) return true;
		}
		return /\s\/\/\s\S/.test(line) || /\s#\s\S/.test(line);
	});
}

const DEFAULT_CHALLENGE = `
COMMENT/DOCSTRING DETECTED in your recent edit.

Respond NOW, in priority order, for EACH detected comment:
1. Pre-existing comment you did not write -> state that it is pre-existing and proceed.
2. BDD given/when/then style -> state it and proceed.
3. Necessary (security, non-obvious algorithm, regex, perf, public API contract) -> justify in one line and keep it.
4. Otherwise -> it is unnecessary: acknowledge, remove it, and make the code self-explanatory.

You MUST respond before continuing. Do not skip this.`;

function challengeText(): string {
	return process.env["TORUS_COMMENT_CHECKER_PROMPT"] ?? DEFAULT_CHALLENGE;
}

interface StashEntry {
	file: string;
	commented: string[];
}

export function registerCommentChecker(pi: ExtensionAPI): void {
	if (process.env["TORUS_COMMENT_CHECKER"] === "0") return;

	const stash = new Map<string, StashEntry>();

	const capture = (event: ToolCallEvent): void => {
		let file: string | null = null;
		let added: string[] = [];
		if (event.toolName === "edit") {
			const input = event.input as {
				path?: string;
				edits?: Array<{ oldText?: string; newText?: string }>;
			};
			if (typeof input.path !== "string" || !Array.isArray(input.edits)) return;
			file = input.path;
			added = addedLinesForEdit(
				input.edits.map((edit) => ({ oldText: edit.oldText ?? "", newText: edit.newText ?? "" })),
			);
		} else if (event.toolName === "write") {
			const input = event.input as { path?: string; content?: string };
			if (typeof input.path !== "string" || typeof input.content !== "string") return;
			file = input.path;
			let disk: string | null = null;
			try {
				disk = readFileSync(input.path, "utf8");
			} catch {
				disk = null;
			}
			added = addedLinesForWrite(input.content, disk);
		} else {
			return;
		}
		const commented = findCommentedLines(added, file);
		if (commented.length === 0) return;
		while (stash.size >= STASH_LIMIT) {
			const oldest = stash.keys().next().value;
			if (oldest === undefined) break;
			stash.delete(oldest);
		}
		stash.set(event.toolCallId, { file, commented });
	};

	const challenge = (event: ToolResultEvent) => {
		const entry = stash.get(event.toolCallId);
		stash.delete(event.toolCallId);
		if (!entry) return undefined;
		return {
			content: [...event.content, { type: "text" as const, text: challengeText() }],
		};
	};

	pi.on("tool_call", capture);
	pi.on("tool_result", challenge);
}

export default function commentCheckerExtension(pi: ExtensionAPI): void {
	registerCommentChecker(pi);
}
