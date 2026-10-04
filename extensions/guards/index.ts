/**
 * torus — context guards + error recovery.
 *
 * Four behaviors that keep context lean and failures recoverable:
 *   - tool-output truncation (giant results capped before they eat context)
 *   - bash file-read guard (cat/head/tail of files -> use the read tool)
 *   - write-overwrite guard (near-identical full rewrites -> edit/hashline)
 *   - error-recovery guidance (structured retry advice appended to failed
 *     edit/bash results instead of raw model flailing)
 *
 * TORUS_GUARDS=0 disables everything; TORUS_MAX_TOOL_OUTPUT tunes the cap.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type BashToolCallEvent,
	type ExtensionAPI,
	isBashToolResult,
	isEditToolResult,
	type ToolResultEvent,
	type WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { torusHome } from "../fsutil.js";

const DEFAULT_MAX_TOOL_OUTPUT = 16_000;
const WRITE_SIMILARITY_BLOCK = 0.7;
const WRITE_MIN_LINES = 5;

export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.6);
	const tail = Math.floor(max * 0.25);
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n…[torus: truncated ${omitted} bytes — rerun the command with narrower scope if you need the middle]…\n${text.slice(text.length - tail)}`;
}

const CAT_FAMILY = /^\s*(cat|head|tail|less|more)\b/;

const GIT_MUTATING =
	/\bgit\b[^<>|;&]*\b(add|commit|rm|mv|restore|checkout|switch|reset|rebase|merge|cherry-pick|revert|clean|tag|stash|init|config|apply|am|worktree|update-ref|symbolic-ref|push|pull|fetch|gc)\b/;
const FILE_MUTATING = /\b(rm|mv|cp|mkdir|touch|tee|truncate|ln|chmod|chown)\b|\bsed\b[^|;&]*\s-i\b/;

/**
 * True when a bash command mutates the torus memory store (referenced by
 * absolute path or ~/.torus/$TORUS_HOME form): mutating git verbs,
 * --no-verify, redirects into the store, or file mutations. Read-only git on
 * the store stays allowed — writes go through torus_remember/torus_forget
 * and are versioned in-process by the memory extension, whose store-local
 * pre-commit hook refuses foreign commits.
 */
export function isMemoryStoreMutation(command: string, storeDir: string): boolean {
	const cmd = command.trim();
	if (cmd.length === 0) return false;
	const needles = [storeDir, ".torus/memory", "$TORUS_HOME/memory"];
	const hit = needles.find((needle) => cmd.includes(needle));
	if (!hit) return false;
	if (GIT_MUTATING.test(cmd)) return true;
	if (cmd.includes("--no-verify")) return true;
	if (FILE_MUTATING.test(cmd)) return true;
	const escaped = hit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`(>>?)\\s*[^|;&>]*${escaped}`).test(cmd)) return true;
	return false;
}

function memoryStoreDir(): string {
	return path.join(torusHome(), "memory");
}

/** True when a bash command is a plain file dump that the read tool should own. */
export function isBareFileDump(command: string): boolean {
	const trimmed = command.trim();
	if (!CAT_FAMILY.test(trimmed)) return false;
	if (/[|;&<>]/.test(trimmed)) return false;
	const tokens = trimmed.split(/\s+/).slice(1);
	const operands = tokens.filter((token) => !token.startsWith("-"));
	if (operands.length === 0) return false;
	const target = operands[operands.length - 1];
	if (target === undefined || !target.startsWith("/")) return false;
	try {
		return statSync(target).isFile();
	} catch {
		return false;
	}
}

/** Line-overlap ratio between disk content and proposed rewrite (0..1). */
export function rewriteSimilarity(disk: string, next: string): number {
	const a = disk.split("\n").filter((line) => line.trim().length > 0);
	const b = next.split("\n").filter((line) => line.trim().length > 0);
	if (a.length === 0 || b.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
	let common = 0;
	for (const line of b) {
		const left = counts.get(line) ?? 0;
		if (left > 0) {
			common += 1;
			counts.set(line, left - 1);
		}
	}
	return common / Math.max(a.length, b.length);
}

const JSON_BREAKAGE_RE = /Unexpected token|is not valid JSON|JSON\.parse|SyntaxError.*JSON/i;

export function recoveryGuidance(kind: "edit" | "json"): string {
	if (kind === "edit") {
		return "\n[torus recovery] Re-read the target region first, then: prefer hashline_edit with anchors copied from the fresh read (hash mismatch will tell you if the file moved again); with edit, quote oldText EXACTLY including indentation; if the block appears multiple times, include surrounding lines to disambiguate; when a batch edit fails, re-check EVERY edits[].oldText against the fresh read — other entries in the batch may be stale too, not just the reported index.";
	}
	return "\n[torus recovery] The command output failed JSON validation. Echo the payload to a file, inspect it with jq (jq . file or jq 'keys'), fix the structure, and re-parse — never hand-retype large JSON from memory.";
}

export function registerGuards(pi: ExtensionAPI): void {
	if (process.env["TORUS_GUARDS"] === "0") return;
	const maxOutput = Number(process.env["TORUS_MAX_TOOL_OUTPUT"] ?? DEFAULT_MAX_TOOL_OUTPUT);

	pi.on("tool_call", (event) => {
		if (event.type !== "tool_call") return undefined;
		if ((event as BashToolCallEvent).toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (command && isBareFileDump(command)) {
				return {
					block: true,
					reason:
						"use the read tool for file contents — it is anchored (hashline), truncation-aware, and keeps context structured; bash dumps bypass all of that",
				};
			}
			if (command && isMemoryStoreMutation(command, memoryStoreDir())) {
				return {
					block: true,
					reason:
						"the torus memory store is tool-mediated and versioned in-process — add/update with torus_remember (force to update in place), delete with torus_forget, bulk-consolidate via /reflect; direct git or file writes to the store are blocked",
				};
			}
		}
		if ((event as WriteToolCallEvent).toolName === "write") {
			const input = event.input as { path?: unknown; content?: unknown };
			if (
				typeof input.path === "string" &&
				typeof input.content === "string" &&
				existsSync(input.path)
			) {
				let disk = "";
				try {
					disk = readFileSync(input.path, "utf8");
				} catch {
					return undefined;
				}
				if (disk.split("\n").length >= WRITE_MIN_LINES) {
					const similarity = rewriteSimilarity(disk, input.content);
					if (similarity >= WRITE_SIMILARITY_BLOCK) {
						return {
							block: true,
							reason: `target already exists and is ${Math.round(similarity * 100)}% identical to this rewrite — use hashline_edit (anchored range replace) or edit (oldText/newText) for surgical changes; full rewrites are only for genuinely new content`,
						};
					}
				}
			}
		}
		return undefined;
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		let appended: string | null = null;

		if (event.isError && isEditToolResult(event)) {
			appended = recoveryGuidance("edit");
		} else if (isBashToolResult(event)) {
			const text = event.content
				.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (JSON_BREAKAGE_RE.test(text)) appended = recoveryGuidance("json");
		}

		const cap = maxOutput > 0 ? maxOutput : DEFAULT_MAX_TOOL_OUTPUT;
		const content = event.content.map((block) =>
			block.type === "text" && block.text.length > cap
				? { ...block, text: truncateText(block.text, cap) }
				: block,
		);

		if (appended && content.length > 0) {
			const last = content[content.length - 1];
			if (last && last.type === "text") {
				content[content.length - 1] = { ...last, text: last.text + appended };
				return { content };
			}
			return { content: [...content, { type: "text" as const, text: appended }] };
		}
		for (let i = 0; i < content.length; i += 1) {
			const block = content[i];
			if (block && event.content[i] !== block) return { content };
		}
		return undefined;
	});
}

export default function guardsExtension(pi: ExtensionAPI): void {
	registerGuards(pi);
}
