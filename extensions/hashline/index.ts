/**
 * torus — hashline extension.
 *
 * Two surfaces: read results gain `{line}#{hash}|` anchors (tool_result
 * rewrite), and the `hashline_edit` tool applies anchor-addressed batch
 * edits with staleness detection via hash mismatch. The engine's native
 * edit/write tools remain available as fallback. TORUS_HASHLINE=0 disables.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	isReadToolResult,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	anchorAll,
	applyHashlineEdits,
	computeLineHash,
	type HashlineEditOp,
	normalizeEdits,
} from "./core.js";

const HASHLINE_EDIT_DESCRIPTION = `Edit files using LINE#ID anchors for precise, safe modifications. Read output shows each line as {line_number}#{hash}|content — copy anchors exactly.

WORKFLOW: read the target file, copy exact LINE#ID tags, submit all operations for one file in a single call, re-read before editing the same file again.

OPERATIONS (edits[] against the ORIGINAL snapshot; applied bottom-up):
- replace with pos only -> replace the single line at pos
- replace with pos+end -> replace inclusive range pos..end (ranges must not overlap in one call; reversed pos/end is auto-swapped)
- append with anchor -> insert AFTER that line; prepend with anchor -> insert BEFORE it
- append/prepend without anchors -> EOF/BOF insertion (appending to a missing path creates the file)
- lines: string[] | string | null (null or [] with replace deletes the range)
- op is optional: replace when pos is given, append otherwise

RULES: replacement lines contain ONLY the content inside the consumed range — surviving neighbors echoed into lines are auto-deduped at the boundaries, but do not rely on it; never guess tags — copy them from read output or from a >>> mismatch error, which shows the CURRENT anchors for self-healing; one logical mutation site per operation, smallest change wins; preserve indentation and formatting exactly.

FILE MODES: delete=true removes the file (edits must be absent or empty); rename writes the final content to a new path and removes the old one.

RECOVERY: on mismatch the error lists CURRENT anchors — copy them and retry, or pass rebase:true to remap each mismatched anchor to the unique line that still carries its content hash (moved-line detection). Success returns a full-file anchor map so follow-up edits in the same file need no re-read.

The native edit tool stays available for simple single-spot string replacements.`;

function splitContent(content: string): {
	lines: string[];
	crlf: boolean;
	trailingNewline: boolean;
} {
	const crlf = content.includes("\r\n");
	const normalized = crlf ? content.replace(/\r\n/g, "\n") : content;
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
	return anchorAll(lines.slice(start - 1, end)).join("\n");
}

function runFormatter(target: string): string {
	const fmtCmd = process.env["TORUS_FMT_CMD"];
	if (!fmtCmd || fmtCmd.trim().length === 0) return "";
	try {
		const run = spawnSync(fmtCmd, [target], { timeout: 15_000, encoding: "utf8" });
		if (run.status === 0) return "\nformatter: ok";
		return `\nformatter: exit ${String(run.status)}`;
	} catch (err) {
		return `\nformatter failed: ${String(err).slice(0, 120)}`;
	}
}

const hashlineEditTool = defineTool({
	name: "hashline_edit",
	label: "Hashline Edit",
	description: HASHLINE_EDIT_DESCRIPTION,
	parameters: Type.Object({
		path: Type.String({ description: "Absolute file path" }),
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
		const { lines, crlf, trailingNewline } = splitContent(source);
		const creating = raw === null;

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
		const fmtNote = runFormatter(target);
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
					(edit) => `${edit.label}:\n${anchoredRegion(displayLines, edit.from, edit.to)}`,
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

function enhanceReadResult(
	event: ToolResultEvent,
): { content: ToolResultEvent["content"] } | undefined {
	if (!isReadToolResult(event)) return undefined;
	let changed = false;
	const content = event.content.map((block) => {
		if (block.type !== "text") return block;
		const lines = block.text.split("\n");
		if (lines.length === 0) return block;
		changed = true;
		return { ...block, text: anchorAll(lines).join("\n") };
	});
	return changed ? { content } : undefined;
}

/**
 * Anchors die the moment any writer touches the file: append a one-line void
 * notice to successful native edit/write results so the model re-reads before
 * its next hashline_edit instead of burning a mismatch round trip.
 */
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

export function registerHashline(pi: ExtensionAPI): void {
	if (process.env["TORUS_HASHLINE"] === "0") return;
	pi.on(
		"tool_result",
		(event: ToolResultEvent) => enhanceReadResult(event) ?? staleAnchorNote(event),
	);
	pi.registerTool(hashlineEditTool);
}

export default function hashlineExtension(pi: ExtensionAPI): void {
	registerHashline(pi);
}
