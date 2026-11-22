/**
 * torus — hashline core.
 *
 * Pure edit-application logic for anchor-addressed edits: reads are rendered
 * with `{line}#{hash}|` anchors and edits reference those anchors instead of
 * string-matching, so staleness is detected (hash mismatch) instead of
 * silently corrupting near-matches. This module has no pi imports so the test
 * suite can pin every contract directly.
 */

const DICT = "ZPMQVRWSNKTXJBYH";

export const LINE_REF_RE = /^(\d+)#([A-Z]{4})$/;
const ANCHOR_PREFIX_RE = /^\d+#[A-Z]{4}\|/;

export interface LineRef {
	line: number;
	hash: string;
}

export interface HashlineEditOp {
	op: "replace" | "append" | "prepend";
	pos?: string;
	end?: string;
	lines?: string[] | string | null;
}

/** Model-submitted edit shape: `op` may be omitted (inferred below). */
export type RawHashlineEdit = Omit<HashlineEditOp, "op"> & { op?: HashlineEditOp["op"] };

/** Infer missing ops (replace when pos is present, else append) and copy. */
export function normalizeEdits(raw: RawHashlineEdit[]): HashlineEditOp[] {
	return raw.map((e) => ({
		op: e.op ?? (e.pos !== undefined ? "replace" : "append"),
		pos: e.pos,
		end: e.end,
		lines: e.lines,
	}));
}

export interface AppliedEdit {
	label: string;
	/** Final line coordinates in the resulting file. */
	from: number;
	to: number;
	removed: string[];
	added: string[];
	indentAdjusted?: boolean;
}

export interface RebaseReport {
	ref: string;
	fromLine: number;
	toLine: number;
}

export type ApplyOutcome =
	| { ok: true; lines: string[]; applied: AppliedEdit[]; moved?: RebaseReport[] }
	| { ok: false; error: string; mismatch: boolean };

export function computeLineHash(line: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < line.length; i += 1) {
		h ^= line.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	const nibbles = [h, h >>> 8, h >>> 16, h >>> 24].map((v) => DICT[v % DICT.length] ?? "Z");
	return nibbles.join("");
}

export function parseLineRef(ref: string): LineRef | null {
	const match = LINE_REF_RE.exec(ref.trim());
	if (!match) return null;
	const line = Number(match[1]);
	const hash = match[2] ?? "";
	if (!Number.isInteger(line) || line < 1) return null;
	return { line, hash };
}

export function anchoredLine(number: number, content: string): string {
	return `${number}#${computeLineHash(content)}|${content}`;
}

export function anchorAll(lines: string[], startLine = 1): string[] {
	return lines.map((content, index) => anchoredLine(startLine + index, content));
}

export function stripAnchorPrefix(line: string): string {
	return line.replace(ANCHOR_PREFIX_RE, "");
}

/**
 * Normalize model-submitted lines: split strings, strip echoed anchor
 * prefixes, and strip leading diff +/- markers (only when followed by a
 * space, so legitimate leading-sign lines survive).
 */
export function normalizeSubmittedLines(raw: string[] | string | null | undefined): string[] {
	if (raw === null || raw === undefined) return [];
	const arr = typeof raw === "string" ? raw.split("\n") : raw.flatMap((line) => line.split("\n"));
	return arr.map((line) => stripAnchorPrefix(line).replace(/^[+-] /, ""));
}

function leadingWs(line: string): string {
	return (line.match(/^\s*/) ?? [""])[0] ?? "";
}

function commonPrefix(a: string, b: string): string {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
	return a.slice(0, n);
}

interface IndentOutcome {
	lines: string[];
	adjusted: boolean;
}

/**
 * Rebase submitted lines onto the removed block's uniform indent base. When
 * the submission's own common leading-whitespace prefix differs from the
 * removed base (spaces instead of tabs, lost nesting, no indent at all), the
 * prefix is swapped for the base so relative nesting survives. Submissions
 * already carrying the base, or blocks with no uniform removed base, pass
 * through untouched.
 */
function restoreIndent(removed: string[], submitted: string[]): IndentOutcome {
	if (submitted.length === 0 || removed.length === 0) return { lines: submitted, adjusted: false };
	const indents = removed.filter((line) => /^\s/.test(line)).map(leadingWs);
	if (indents.length === 0) return { lines: submitted, adjusted: false };
	const base = indents[0] ?? "";
	if (base.length === 0 || !indents.every((indent) => indent === base))
		return { lines: submitted, adjusted: false };
	const nonEmpty = submitted.filter((line) => line.length > 0);
	if (nonEmpty.length === 0) return { lines: submitted, adjusted: false };
	let submittedBase = leadingWs(nonEmpty[0] ?? "");
	for (const line of nonEmpty.slice(1))
		submittedBase = commonPrefix(submittedBase, leadingWs(line));
	if (submittedBase === base) return { lines: submitted, adjusted: false };
	return {
		lines: submitted.map((line) =>
			line.length === 0 ? line : base + line.slice(submittedBase.length),
		),
		adjusted: true,
	};
}

interface Span {
	start: number;
	end: number;
}

function opSpan(op: HashlineEditOp, pos: LineRef, end: LineRef | null): Span {
	if (op.op === "replace") return { start: pos.line, end: end?.line ?? pos.line };
	return { start: pos.line, end: end?.line ?? pos.line };
}

function overlap(a: Span, b: Span): boolean {
	return a.start <= b.end && b.start <= a.end;
}

/** Index every line hash to its 1-based line numbers, in one pass. */
function indexHashes(lines: string[]): Map<string, number[]> {
	const index = new Map<string, number[]>();
	for (let i = 0; i < lines.length; i += 1) {
		const hash = computeLineHash(lines[i] ?? "");
		const hits = index.get(hash);
		if (hits === undefined) index.set(hash, [i + 1]);
		else hits.push(i + 1);
	}
	return index;
}

/**
 * Verify anchors against current content; on drift, produce a mismatch error
 * that classifies each bad anchor (moved to a unique line, ambiguous, or not
 * present anywhere in the file) and shows corrected anchors for the requested
 * lines (±3 context) so the caller can self-heal without a full re-read.
 */
export function verifyAnchors(
	lines: string[],
	refs: Array<{ ref: string; at: LineRef }>,
): string | null {
	const problems: string[] = [];
	const seen = new Set<string>();
	let index: Map<string, number[]> | null = null;
	for (const { ref, at } of refs) {
		if (seen.has(ref)) continue;
		seen.add(ref);
		const current = lines[at.line - 1];
		if (current === undefined) {
			index ??= indexHashes(lines);
			const hits = index.get(at.hash) ?? [];
			const where =
				hits.length === 1
					? `; that content is now at line ${hits[0]}`
					: hits.length > 1
						? `; that content is now at lines ${hits.join(", ")}`
						: "";
			problems.push(
				`  ${ref}: line ${at.line} is beyond end of file (file has ${lines.length} lines)${where}`,
			);
			continue;
		}
		const actual = computeLineHash(current);
		if (actual !== at.hash) {
			index ??= indexHashes(lines);
			const hits = index.get(at.hash) ?? [];
			if (hits.length === 1)
				problems.push(
					`  ${ref}: content moved — now at line ${hits[0]} (file has ${at.line}#${actual}); retry with rebase:true or a fresh anchor`,
				);
			else if (hits.length > 1)
				problems.push(
					`  ${ref}: content appears at lines ${hits.join(", ")} — re-read and anchor the line you mean (file has ${at.line}#${actual})`,
				);
			else
				problems.push(
					`  ${ref}: no line in this file carries that hash — anchors must be copied verbatim from a read of this file (line ${at.line} is now ${at.line}#${actual})`,
				);
		}
	}
	if (problems.length === 0) return null;

	const context = new Set<number>();
	for (const { at } of refs) {
		for (let n = at.line - 3; n <= at.line + 3; n += 1) {
			if (n >= 1 && n <= lines.length) context.add(n);
		}
	}
	if (context.size === 0) {
		for (let n = 1; n <= Math.min(lines.length, 10); n += 1) context.add(n);
	}
	const anchored = [...context]
		.sort((a, b) => a - b)
		.map((n) => `  ${anchoredLine(n, lines[n - 1] ?? "")}`)
		.join("\n");
	return `>>> mismatch — the submitted LINE#ID tags do not match the current file (they are VOID).\n${problems.join("\n")}\nCurrent anchors:\n${anchored}\nCopy fresh tags from the Current anchors block above (or re-read the file; offset reads carry true line numbers) and retry. For anchors marked “moved”, rebase:true remaps them automatically.`;
}

/**
 * Moved-line rebasing: an anchor whose hash no longer matches at its position
 * is remapped only when EXACTLY ONE line in the file still carries that hash.
 * Any ambiguous or vanished anchor aborts the rebase; the caller then reports
 * the mismatch as-is. Hash occurrences are indexed in one pass up front, so
 * resolving N stale anchors costs one hash per line, not one scan per anchor.
 */
function tryRebase(
	lines: string[],
	refs: Array<{ ref: string; at: LineRef }>,
): { remap: Map<string, LineRef>; moved: RebaseReport[] } | null {
	const remap = new Map<string, LineRef>();
	const moved: RebaseReport[] = [];
	const index = indexHashes(lines);
	for (const { ref, at } of refs) {
		const current = lines[at.line - 1];
		if (current !== undefined && computeLineHash(current) === at.hash) continue;
		if (remap.has(ref)) continue;
		const hits = index.get(at.hash);
		if (hits === undefined || hits.length !== 1) return null;
		const toLine = hits[0];
		if (toLine === undefined) return null;
		remap.set(ref, { line: toLine, hash: at.hash });
		moved.push({ ref, fromLine: at.line, toLine });
	}
	return { remap, moved };
}

/**
 * Apply a batch of hashline operations against the ORIGINAL snapshot,
 * bottom-up (highest line first) so earlier ops do not shift later anchors.
 * Every op requires `lines` (null/[] with replace deletes the range). Inserts
 * anchor at pos or end (one line, not both). Replace spans must not overlap;
 * insertions may not land strictly inside a replaced span. Boundary-echo
 * dedup drops submitted lines that exactly duplicate the surviving neighbors
 * of a replace range; a uniform indent base is restored and flagged. Reversed
 * pos/end is normalized by swapping (the span is direction-agnostic). With
 * options.rebase, mismatched anchors are remapped to the unique line that
 * still carries their content hash instead of failing. AppliedEdit from/to
 * carry FINAL coordinates in the resulting file.
 */
export function applyHashlineEdits(
	lines: string[],
	ops: HashlineEditOp[],
	options?: { rebase?: boolean },
): ApplyOutcome {
	const refs: Array<{ ref: string; at: LineRef }> = [];
	const normalized: HashlineEditOp[] = [];

	for (let op of ops) {
		if (op.op === "replace" && !op.pos)
			return { ok: false, error: "replace requires pos", mismatch: false };
		if (op.lines === undefined)
			return {
				ok: false,
				error: `${op.op} needs "lines" — a string or string[] (null or [] with replace deletes the range)`,
				mismatch: false,
			};
		if (op.op !== "replace") {
			const p0 = op.pos ? parseLineRef(op.pos) : null;
			const e0 = op.end ? parseLineRef(op.end) : null;
			if (p0 && e0 && p0.line !== e0.line)
				return {
					ok: false,
					error: `${op.op} inserts at ONE anchor line — pos (${op.pos}) and end (${op.end}) name different lines; keep the anchor you mean`,
					mismatch: false,
				};
		}
		if (op.pos && op.end) {
			const p = parseLineRef(op.pos);
			const e = parseLineRef(op.end);
			if (p && e && e.line < p.line) {
				const swap = op.pos;
				op = { ...op, pos: op.end, end: swap };
			}
		}
		const anchors = [op.pos, op.end].filter((ref): ref is string => typeof ref === "string");
		for (const ref of anchors) {
			const at = parseLineRef(ref);
			if (!at)
				return { ok: false, error: `invalid anchor "${ref}" (expected N#XXXX)`, mismatch: false };
			refs.push({ ref, at });
		}
		normalized.push(op);
	}

	const mismatch = verifyAnchors(lines, refs);
	let moved: RebaseReport[] | undefined;
	if (mismatch) {
		if (!options?.rebase) return { ok: false, error: mismatch, mismatch: true };
		const rebased = tryRebase(lines, refs);
		if (!rebased) return { ok: false, error: mismatch, mismatch: true };
		moved = rebased.moved;
		for (let i = 0; i < normalized.length; i += 1) {
			const op = normalized[i];
			if (!op) continue;
			const rp = op.pos !== undefined ? rebased.remap.get(op.pos) : undefined;
			const re = op.end !== undefined ? rebased.remap.get(op.end) : undefined;
			if (rp || re) {
				normalized[i] = {
					...op,
					pos: rp ? `${rp.line}#${rp.hash}` : op.pos,
					end: re ? `${re.line}#${re.hash}` : op.end,
				};
			}
		}
		// A remap can land range endpoints in inverted order (the anchors moved
		// apart, not together), or pull a same-line insert's pos and end onto
		// different lines; either way the span is not the one the caller meant,
		// and splicing it corrupts silently. Abort the rebase and let the
		// mismatch error's moved-line report guide a fresh read.
		for (const op of normalized) {
			const p = op.pos ? parseLineRef(op.pos) : null;
			const e = op.end ? parseLineRef(op.end) : null;
			if (p && e && e.line < p.line) return { ok: false, error: mismatch, mismatch: true };
			if (p && e && op.op !== "replace" && p.line !== e.line)
				return { ok: false, error: mismatch, mismatch: true };
		}
	}

	const parsed: Array<{
		op: HashlineEditOp;
		pos: LineRef | null;
		end: LineRef | null;
		newLines: string[];
	}> = normalized.map((op) => ({
		op,
		pos: op.pos ? parseLineRef(op.pos) : null,
		end: op.end ? parseLineRef(op.end) : null,
		newLines: normalizeSubmittedLines(op.lines),
	}));

	for (const p of parsed) {
		if (p.op.op !== "replace" && p.newLines.length === 0)
			return { ok: false, error: `${p.op.op} needs at least one line`, mismatch: false };
	}

	const replaceSpans = parsed
		.filter((p): p is typeof p & { pos: LineRef } => p.op.op === "replace" && p.pos !== null)
		.map((p) => opSpan(p.op, p.pos, p.end));
	for (let i = 0; i < replaceSpans.length; i += 1) {
		for (let j = i + 1; j < replaceSpans.length; j += 1) {
			const a = replaceSpans[i];
			const b = replaceSpans[j];
			if (a && b && overlap(a, b)) {
				return {
					ok: false,
					error: "replace ranges must not overlap — split into separate calls",
					mismatch: false,
				};
			}
		}
	}
	const anchorOf = (p: (typeof parsed)[number]): number => {
		const anchor = p.pos ?? p.end;
		if (p.op.op === "replace") return p.pos?.line ?? 0;
		// +0.25/-0.5 keep an append-after-N and a prepend-before-(N+1) at the
		// same boundary on distinct anchors, so application order and final
		// coordinates stay well-defined for the pair.
		if (p.op.op === "append") return anchor ? anchor.line + 0.25 : Number.MAX_SAFE_INTEGER;
		return anchor ? anchor.line - 0.5 : 0;
	};

	for (const p of parsed) {
		if (p.op.op !== "replace") {
			const at = anchorOf(p);
			if (replaceSpans.some((s) => at > s.start && at < s.end)) {
				return {
					ok: false,
					error: "insertion anchor is strictly inside a replaced range in the same call",
					mismatch: false,
				};
			}
		}
	}

	const result = [...lines];
	const applied: AppliedEdit[] = [];
	const appliedAnchors: number[] = [];
	const order = [...parsed]
		.map((p) => ({ p, anchor: anchorOf(p) }))
		.sort((a, b) => b.anchor - a.anchor);

	for (const { p, anchor } of order) {
		if (p.op.op === "replace" && p.pos) {
			const start = p.pos.line;
			const end = p.end?.line ?? p.pos.line;
			const removed = result.slice(start - 1, end);
			const indent = restoreIndent(removed, p.newLines);
			let newLines = indent.lines;
			const before = result[start - 2];
			const after = result[end];
			while (newLines.length > 0 && before !== undefined && newLines[0] === before)
				newLines = newLines.slice(1);
			while (newLines.length > 0 && after !== undefined && newLines[newLines.length - 1] === after)
				newLines = newLines.slice(0, -1);
			result.splice(start - 1, end - start + 1, ...newLines);
			applied.push({
				label: `replace ${start}${end !== start ? `-${end}` : ""}`,
				from: start,
				to: start + newLines.length - 1,
				removed,
				added: [...newLines],
				...(indent.adjusted ? { indentAdjusted: true } : {}),
			});
			appliedAnchors.push(anchor);
		} else if (p.op.op === "append") {
			const at = p.pos?.line ?? p.end?.line ?? result.length;
			result.splice(at, 0, ...p.newLines);
			applied.push({
				label: at === 0 ? "insert at 1" : `insert after ${at}`,
				from: at + 1,
				to: at + p.newLines.length,
				removed: [],
				added: [...p.newLines],
			});
			appliedAnchors.push(anchor);
		} else if (p.op.op === "prepend") {
			const at = p.pos?.line ?? p.end?.line ?? 1;
			result.splice(at - 1, 0, ...p.newLines);
			applied.push({
				label: `insert before ${at}`,
				from: at,
				to: at + p.newLines.length - 1,
				removed: [],
				added: [...p.newLines],
			});
			appliedAnchors.push(anchor);
		}
	}

	// applied[] is in application order (descending anchor, ties keep
	// submission order). An edit's final position shifts by the net delta of
	// edits applied after it that landed above it: strictly-above edits (a
	// smaller anchor), and same-anchor edits that spliced at or before the
	// earlier edit's splice index (a later splice at the same index lands on
	// top — stacked anchorless prepends; a strictly-larger index lands below,
	// like stacked EOF appends). Rewrite from/to into final coordinates so
	// region displays and anchor maps share one frame.
	const appliedFrom = applied.map((e) => e.from);
	for (let i = applied.length - 1; i >= 0; i -= 1) {
		const edit = applied[i];
		if (!edit) continue;
		const myAnchor = appliedAnchors[i] ?? Number.MAX_SAFE_INTEGER;
		let shift = 0;
		for (let k = applied.length - 1; k > i; k -= 1) {
			const above = applied[k];
			if (!above) continue;
			const anchorK = appliedAnchors[k] ?? 0;
			const landedAbove =
				anchorK < myAnchor ||
				(anchorK === myAnchor && (appliedFrom[k] ?? 0) <= (appliedFrom[i] ?? 0));
			if (landedAbove) shift += above.added.length - above.removed.length;
		}
		edit.from += shift;
		edit.to += shift;
	}

	return moved?.length
		? { ok: true, lines: result, applied, moved }
		: { ok: true, lines: result, applied };
}
