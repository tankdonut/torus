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
	from: number;
	to: number;
	removed: string[];
	added: string[];
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

export function anchorAll(lines: string[]): string[] {
	return lines.map((content, index) => anchoredLine(index + 1, content));
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

function restoreIndent(removed: string[], submitted: string[]): string[] {
	if (submitted.length === 0 || removed.length === 0) return submitted;
	if (!submitted.every((line) => line.length === 0 || !/^\s/.test(line))) return submitted;
	const indents = removed
		.filter((line) => /^\s/.test(line))
		.map((line) => (line.match(/^\s*/) ?? [""])[0] ?? "");
	if (indents.length === 0) return submitted;
	const base = indents[0] ?? "";
	if (base.length === 0 || !indents.every((indent) => indent === base)) return submitted;
	return submitted.map((line) => (line.length === 0 ? line : base + line));
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

/**
 * Verify anchors against current content; on drift, produce a mismatch error
 * with corrected anchors for the requested lines (±3 context) so the caller
 * can self-heal without a full re-read.
 */
export function verifyAnchors(
	lines: string[],
	refs: Array<{ ref: string; at: LineRef }>,
): string | null {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const { ref, at } of refs) {
		if (seen.has(ref)) continue;
		seen.add(ref);
		const current = lines[at.line - 1];
		if (current === undefined) {
			problems.push(
				`  ${ref}: line ${at.line} is beyond end of file (file has ${lines.length} lines)`,
			);
			continue;
		}
		const actual = computeLineHash(current);
		if (actual !== at.hash) {
			problems.push(`  ${ref}: expected content hash changed (file now ${at.line}#${actual})`);
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
	return `>>> mismatch — file changed since your read; your submitted anchors are VOID.\n${problems.join("\n")}\nCurrent anchors:\n${anchored}\nCopy the updated LINE#ID tags from above (or re-read the file) and retry — re-sending the same stale anchors will fail again.`;
}

/**
 * Moved-line rebasing: an anchor whose hash no longer matches at its position
 * is remapped only when EXACTLY ONE line in the file still carries that hash.
 * Any ambiguous or vanished anchor aborts the rebase; the caller then reports
 * the mismatch as-is.
 */
function tryRebase(
	lines: string[],
	refs: Array<{ ref: string; at: LineRef }>,
): { remap: Map<string, LineRef>; moved: RebaseReport[] } | null {
	const remap = new Map<string, LineRef>();
	const moved: RebaseReport[] = [];
	for (const { ref, at } of refs) {
		const current = lines[at.line - 1];
		if (current !== undefined && computeLineHash(current) === at.hash) continue;
		let to = 0;
		let matches = 0;
		for (let i = 0; i < lines.length; i += 1) {
			if (computeLineHash(lines[i] ?? "") !== at.hash) continue;
			matches += 1;
			to = i + 1;
			if (matches > 1) return null;
		}
		if (matches !== 1) return null;
		remap.set(ref, { line: to, hash: at.hash });
		moved.push({ ref, fromLine: at.line, toLine: to });
	}
	return { remap, moved };
}

/**
 * Apply a batch of hashline operations against the ORIGINAL snapshot,
 * bottom-up (highest line first) so earlier ops do not shift later anchors.
 * Replace spans must not overlap; insertions may not land strictly inside a
 * replaced span. Boundary-echo dedup drops submitted lines that exactly
 * duplicate the surviving neighbors of a replace range. Reversed pos/end is
 * normalized by swapping (the span is direction-agnostic). With
 * options.rebase, mismatched anchors are remapped to the unique line that
 * still carries their content hash instead of failing.
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
	for (const p of parsed) {
		if (
			p.op.op !== "replace" &&
			p.pos &&
			replaceSpans.some((s) => p.pos && p.pos.line > s.start && p.pos.line < s.end)
		) {
			return {
				ok: false,
				error: "insertion anchor is strictly inside a replaced range in the same call",
				mismatch: false,
			};
		}
	}

	const result = [...lines];
	const applied: AppliedEdit[] = [];
	const order = [...parsed].sort((a, b) => {
		const al = a.pos?.line ?? (a.op.op === "append" ? Number.MAX_SAFE_INTEGER : 0);
		const bl = b.pos?.line ?? (b.op.op === "append" ? Number.MAX_SAFE_INTEGER : 0);
		return bl - al;
	});

	for (const p of order) {
		if (p.op.op === "replace" && p.pos) {
			const start = p.pos.line;
			const end = p.end?.line ?? p.pos.line;
			const removed = result.slice(start - 1, end);
			let newLines = restoreIndent(removed, p.newLines);
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
			});
		} else if (p.op.op === "append") {
			const at = p.pos?.line ?? result.length;
			result.splice(at, 0, ...p.newLines);
			applied.push({
				label: `insert after ${at}`,
				from: at + 1,
				to: at + p.newLines.length,
				removed: [],
				added: [...p.newLines],
			});
		} else if (p.op.op === "prepend") {
			const at = p.pos?.line ?? 1;
			result.splice(at - 1, 0, ...p.newLines);
			applied.push({
				label: `insert before ${at}`,
				from: at,
				to: at + p.newLines.length - 1,
				removed: [],
				added: [...p.newLines],
			});
		}
	}

	return moved?.length
		? { ok: true, lines: result, applied, moved }
		: { ok: true, lines: result, applied };
}
