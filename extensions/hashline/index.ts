/**
 * torus — hashline extension.
 *
 * Two surfaces: read results gain `{line}#{hash}|` anchors (tool_result
 * rewrite), and the `hashline_edit` tool applies anchor-addressed batch
 * edits with staleness detection via hash mismatch. The engine's native
 * edit/write tools remain available as fallback. TORUS_HASHLINE=0 disables.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	defineTool,
	type ExtensionAPI,
	isReadToolResult,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { knobBoolean, knobString, parseZeroDisables } from "../config/knobs.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import {
	anchorAll,
	anchoredLine,
	applyHashlineEdits,
	computeLineHash,
	type HashlineEditOp,
	normalizeEdits,
} from "./core.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
	note: "optional post-edit formatter via TORUS_FMT_CMD",
};

const HASHLINE_EDIT_DESCRIPTION = `Edit files using LINE#ID anchors for precise, safe modifications. Read output shows each line as {line_number}#{hash}|content with true file line numbers (offset reads included) — copy anchors exactly.

WORKFLOW: read the target file, copy exact LINE#ID tags, submit all operations for one file in a single call, re-read before editing the same file again (the success result's anchor map also carries fresh tags).

OPERATIONS (edits[] against the ORIGINAL snapshot; applied bottom-up):
- replace with pos only -> replace the single line at pos
- replace with pos+end -> replace inclusive range pos..end (ranges must not overlap in one call; reversed pos/end is auto-swapped)
- append with pos OR end -> insert AFTER that anchor line; prepend with pos OR end -> insert BEFORE it (pos and end must name the same line)
- append/prepend without anchors -> EOF/BOF insertion (appending to a missing path creates the file)
- lines is required on every op: a string, string[], or null — null or [] with replace deletes the range; inserts need at least one line
- op is optional: replace when pos is given, append otherwise

RULES: replacement lines contain ONLY the content inside the consumed range — a uniform indent base is restored automatically (flagged in the result), so keep relative nesting; boundary-echoed neighbors are auto-deduped; never guess tags — copy them from read output, the Current anchors block of a >>> mismatch error, or the success anchor map; one logical mutation site per operation, smallest change wins; preserve formatting.

FILE MODES: delete=true removes the file (edits must be absent or empty); rename writes the final content to a new path and removes the old one.

RECOVERY: a mismatch error classifies each bad anchor — moved (retry with rebase:true to remap to the unique line carrying that content) or not-from-this-file (re-read and copy). Success shows per-edit regions and the anchor map in FINAL line coordinates.

The native edit tool stays available for simple single-spot string replacements.`;

function splitContent(content: string): {
	lines: string[];
	crlf: boolean;
	trailingNewline: boolean;
} {
	const crlf = content.includes("\r\n");
	const normalized = crlf ? content.replace(/\r\n/g, "\n") : content;
	if (normalized === "") return { lines: [], crlf, trailingNewline: true };
	const trailingNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (trailingNewline) lines.pop();
	return { lines, crlf, trailingNewline };
}

function joinContent(lines: string[], crlf: boolean, trailingNewline: boolean): string {
	const eol = crlf ? "\r\n" : "\n";
	if (lines.length === 0) return trailingNewline ? eol : "";
	return lines.join(eol) + (trailingNewline ? eol : "");
}

function toolDetails(d: Record<string, unknown>): Record<string, unknown> {
	return d;
}

function anchoredRegion(lines: string[], from: number, to: number): string {
	const start = Math.max(1, from - 3);
	const end = Math.min(lines.length, to + 3);
	const out: string[] = [];
	for (let n = start; n <= end; n += 1) out.push(anchoredLine(n, lines[n - 1] ?? ""));
	return out.join("\n");
}

export function runFormatter(target: string): Promise<string> {
	const fmtCmd = knobString("TORUS_FMT_CMD", "hashline", "fmtCmd", "");
	if (!fmtCmd || fmtCmd.trim().length === 0) return Promise.resolve("");
	return new Promise((resolve) => {
		let settled = false;
		const finish = (note: string) => {
			if (settled) return;
			settled = true;
			resolve(note);
		};
		try {
			const child = spawn(fmtCmd, [target], { timeout: 15_000, stdio: "ignore" });
			// Spawn failures and the 15s kill both surface as a null exit code,
			// matching the spawnSync timeout semantics this replaced.
			child.on("error", () => finish("\nformatter: exit null"));
			child.on("close", (code) =>
				finish(code === 0 ? "\nformatter: ok" : `\nformatter: exit ${String(code)}`),
			);
		} catch (err) {
			finish(`\nformatter failed: ${String(err).slice(0, 120)}`);
		}
	});
}

const hashlineEditTool = defineTool({
	name: "hashline_edit",
	label: "Hashline Edit",
	description: HASHLINE_EDIT_DESCRIPTION,
	parameters: Type.Object({
		path: Type.String({
			description: "File path (absolute, or relative to the working directory)",
		}),
		edits: Type.Optional(
			Type.Array(
				Type.Object({
					op: Type.Optional(
						Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")]),
					),
					pos: Type.Optional(
						Type.String({ description: 'Anchor "N#XXXX" copied from read output' }),
					),
					end: Type.Optional(Type.String({ description: 'Range end anchor "N#XXXX"' })),
					lines: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String(), Type.Null()])),
				}),
			),
		),
		delete: Type.Optional(Type.Boolean({ description: "Delete the file (no edits)" })),
		rename: Type.Optional(
			Type.String({ description: "Write final content to this path and remove the old one" }),
		),
		rebase: Type.Optional(
			Type.Boolean({
				description:
					"On anchor mismatch, remap each stale anchor to the unique line still carrying its content hash instead of failing",
			}),
		),
	}),
	async execute(_toolCallId, params) {
		const ops: HashlineEditOp[] = normalizeEdits(Array.isArray(params.edits) ? params.edits : []);

		if (params.delete) {
			if (ops.length > 0) {
				return {
					content: [{ type: "text", text: "delete=true requires edits to be absent or empty" }],
					details: toolDetails({ error: "invalid" }),
					isError: true,
				};
			}
			try {
				rmSync(params.path);
				return {
					content: [{ type: "text", text: `deleted ${params.path}` }],
					details: toolDetails({ deleted: true }),
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `delete failed: ${String(err)}` }],
					details: toolDetails({ error: "io" }),
					isError: true,
				};
			}
		}

		if (ops.length === 0) {
			return {
				content: [{ type: "text", text: "no operations given — provide edits[] or delete=true" }],
				details: toolDetails({ error: "invalid" }),
				isError: true,
			};
		}

		let raw: string | null = null;
		try {
			raw = readFileSync(params.path, "utf8");
		} catch {
			raw = null;
		}
		if (raw === null && ops.some((op) => op.op === "replace")) {
			return {
				content: [
					{
						type: "text",
						text: "file does not exist — replace needs existing anchors; use append (or prepend) to create it",
					},
				],
				details: toolDetails({ error: "missing-file" }),
				isError: true,
			};
		}

		const source = raw ?? "";
		const creating = raw === null;
		const { lines, crlf, trailingNewline } = creating
			? { lines: [] as string[], crlf: false, trailingNewline: true }
			: splitContent(source);

		const outcome = applyHashlineEdits(lines, ops, { rebase: params.rebase === true });
		if (!outcome.ok) {
			return {
				content: [{ type: "text", text: outcome.error }],
				details: toolDetails({ error: outcome.mismatch ? "mismatch" : "invalid" }),
				isError: true,
			};
		}

		const content = joinContent(outcome.lines, crlf && !creating, trailingNewline || creating);
		try {
			if (params.rename) {
				writeFileSync(params.rename, content, "utf8");
				rmSync(params.path, { force: true });
			} else {
				writeFileSync(params.path, content, "utf8");
			}
		} catch (err) {
			return {
				content: [{ type: "text", text: `write failed: ${String(err)}` }],
				details: toolDetails({ error: "io" }),
				isError: true,
			};
		}

		const target = params.rename ?? params.path;
		const fmtNote = await runFormatter(target);
		let displayLines = outcome.lines;
		let fmtChanged = false;
		if (fmtNote === "\nformatter: ok") {
			try {
				const diskRaw = readFileSync(target, "utf8");
				fmtChanged = diskRaw !== content;
				if (fmtChanged) displayLines = splitContent(diskRaw).lines;
			} catch {
				/* formatter output unreadable — keep in-memory lines */
			}
		}
		const parts = fmtChanged
			? [
					"formatter rewrote the file — per-edit regions omitted; the anchor map below reflects disk",
				]
			: outcome.applied.map(
					(edit) =>
						`${edit.label}${edit.indentAdjusted ? " [indent normalized]" : ""}:\n${anchoredRegion(displayLines, edit.from, edit.to)}`,
				);
		const mapCap = 400;
		const mapItems = displayLines
			.slice(0, mapCap)
			.map((line, i) => `${i + 1}#${computeLineHash(line)}`);
		const mapTail = displayLines.length > mapCap ? ` …+${displayLines.length - mapCap} more` : "";
		const rebaseNote = outcome.moved?.length
			? `\n\nrebased (moved lines): ${outcome.moved
					.map((m) => `${m.ref} -> line ${m.toLine}`)
					.join(", ")}`
			: "";
		return {
			content: [
				{
					type: "text",
					text: `applied ${outcome.applied.length} op(s) to ${target}${fmtNote}\n\n${parts.join("\n\n")}\n\nAnchor map (fresh N#XXXX for every line):\n${mapItems.join(" ")}${mapTail}${rebaseNote}`,
				},
			],
			details: toolDetails({
				ops: outcome.applied.length,
				path: target,
				edits: outcome.applied.map((edit) => ({
					label: edit.label,
					removed: edit.removed.slice(0, 20),
					added: edit.added.slice(0, 20),
				})),
				...(outcome.moved?.length ? { moved: outcome.moved } : {}),
			}),
		};
	},
});

const READ_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file|Line \d+ is )/;

/**
 * Anchor read results with true file line numbers: an offset read numbers
 * from its offset instead of restarting at 1, and the read tool's bracketed
 * continuation notices (plus the blank separator before them) are metadata,
 * not file content, so they never receive anchors.
 */
function enhanceReadResult(
	event: ToolResultEvent,
): { content: ToolResultEvent["content"] } | undefined {
	if (event.isError) return undefined;
	if (!isReadToolResult(event)) return undefined;
	const offsetRaw = event.input?.["offset"];
	const floored = typeof offsetRaw === "number" ? Math.floor(offsetRaw) : 1;
	const offset = floored >= 1 ? floored : 1;
	let changed = false;
	const content = event.content.map((block) => {
		if (block.type !== "text") return block;
		if (block.text.startsWith("Read image file [")) return block;
		const lines = block.text.split("\n");
		if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return block;
		let lastContent = lines.length - 1;
		while (lastContent >= 0 && (lines[lastContent] ?? "").length === 0) lastContent -= 1;
		let anchorCount = lines.length;
		if (lastContent >= 0 && READ_NOTICE_RE.test(lines[lastContent] ?? "")) {
			anchorCount = lastContent;
			if (anchorCount > 0 && (lines[anchorCount - 1] ?? "").length === 0) anchorCount -= 1;
		}
		if (anchorCount === 0) return block;
		changed = true;
		const tail = lines.slice(anchorCount);
		return {
			...block,
			text: [...anchorAll(lines.slice(0, anchorCount), offset), ...tail].join("\n"),
		};
	});
	return changed ? { content } : undefined;
}

/**
 * Anchors die the moment any writer touches the file: append a one-line void
 * notice to successful native edit/write results, and to successful bash
 * results whose command plausibly writes files (sed -i, redirects, mv, git
 * checkout, package installs), so the model re-reads before its next
 * hashline_edit instead of burning a mismatch round trip. Redirects to
 * /dev/null are excluded as no-op writes. False positives only cost a
 * re-read; false negatives self-heal via the mismatch error.
 */
const BASH_WRITE_RE =
	/(?<![\w>])(?:sed|perl|awk|gawk)\b[^\n|;&]*(?:--in-place\b|-n\s+inplace\b|-[a-zA-Z]*i[a-zA-Z]*\b)|(?<![\w>])(?:tee|mv|cp|rm|rmdir|truncate|shred|dd|rsync|install|patch)\b|(?<![\w>])(?:\d)?>{1,2}(?=\s*(?!\/dev\/null\b)[^&\s>])|(?<![\w>])git\s+(?:apply|checkout|restore|clean|stash|merge|rebase|cherry-pick|reset)\b|(?<![\w>])(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|update|uninstall|link)\b/;

/**
 * Whether anchored content is live in the conversation: armed by a read that
 * gained anchors (or a successful hashline_edit, whose result carries a
 * fresh anchor map), disarmed when the bash mutation note fires. Sessions
 * that never hold anchors pay no notes, and a run of mutating commands
 * warns once instead of on every command — the mismatch error self-heals
 * whatever the single notice misses.
 */
interface AnchorState {
	live: boolean;
}

function staleAnchorNote(
	event: ToolResultEvent,
): { content: ToolResultEvent["content"] } | undefined {
	if (event.isError) return undefined;
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	const path = typeof event.input?.["path"] === "string" ? event.input["path"] : "this file";
	return {
		content: [
			...event.content,
			{
				type: "text",
				text: `[hashline] anchors for ${path} are void — re-read before hashline_edit.`,
			},
		],
	};
}

function bashMutationNote(
	event: ToolResultEvent,
	state: AnchorState,
): { content: ToolResultEvent["content"] } | undefined {
	if (event.isError || event.toolName !== "bash") return undefined;
	const command = event.input?.["command"];
	if (typeof command !== "string" || !BASH_WRITE_RE.test(command)) return undefined;
	if (!state.live) return undefined;
	state.live = false;
	return {
		content: [
			...event.content,
			{
				type: "text",
				text: "[hashline] writes files — re-read before hashline_edit.",
			},
		],
	};
}

export function registerHashline(pi: ExtensionAPI): void {
	if (!knobBoolean("TORUS_HASHLINE", "hashline", "enabled", true, parseZeroDisables)) return;
	const anchors: AnchorState = { live: false };
	pi.on("tool_result", (event: ToolResultEvent) => {
		const enhanced = enhanceReadResult(event);
		if (enhanced) {
			anchors.live = true;
			return enhanced;
		}
		// A successful hashline_edit result carries a fresh anchor map.
		if (!event.isError && event.toolName === "hashline_edit" && event.input?.["delete"] !== true) {
			anchors.live = true;
		}
		return staleAnchorNote(event) ?? bashMutationNote(event, anchors);
	});
	pi.registerTool(hashlineEditTool);
}

export default function hashlineExtension(pi: ExtensionAPI): void {
	if (!gateExtension("hashline", PLATFORM_SUPPORT)) return;
	registerHashline(pi);
}
