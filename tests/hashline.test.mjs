import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const {
	anchorAll,
	applyHashlineEdits,
	computeLineHash,
	normalizeEdits,
	normalizeSubmittedLines,
	parseLineRef,
	stripAnchorPrefix,
	verifyAnchors,
} = await import("../extensions/hashline/core.ts");
const { registerHashline, runFormatter } = await import("../extensions/hashline/index.ts");

test("computeLineHash: deterministic, 4 dict chars, distinguishes content", () => {
	const a = computeLineHash("const x = 1;");
	assert.equal(computeLineHash("const x = 1;"), a);
	assert.match(a, /^[A-Z]{4}$/);
	assert.notEqual(computeLineHash("const x = 2;"), a);
	assert.equal(computeLineHash(""), computeLineHash(""));
});

test("parseLineRef: strict N#XXXX form", () => {
	assert.deepEqual(parseLineRef("12#XJQT"), { line: 12, hash: "XJQT" });
	assert.equal(parseLineRef("12#xjqt"), null);
	assert.equal(parseLineRef("12#XJ"), null);
	assert.equal(parseLineRef("0#XJQT"), null);
	assert.equal(parseLineRef("12"), null);
	assert.equal(parseLineRef("#XJQT"), null);
});

test("anchoredLine/anchorAll round-trip with stripAnchorPrefix", () => {
	const lines = ["alpha", "beta", "gamma"];
	const anchored = anchorAll(lines);
	assert.match(anchored[0] ?? "", /^1#[A-Z]{4}\|alpha$/);
	const stripped = anchored.map(stripAnchorPrefix);
	assert.deepEqual(stripped, lines);
});

test("normalizeSubmittedLines: string split, anchor + diff-marker stripping", () => {
	assert.deepEqual(normalizeSubmittedLines("a\nb"), ["a", "b"]);
	assert.deepEqual(
		normalizeSubmittedLines(["3#QQZZ|kept", "+ added", "- removed", "kept-plus + sign"]),
		["kept", "added", "removed", "kept-plus + sign"],
	);
	assert.deepEqual(normalizeSubmittedLines(null), []);
});

test("applyHashlineEdits: single-line replace via verified anchor", () => {
	const lines = ["one", "two", "three"];
	const pos = `2#${computeLineHash("two")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos, lines: ["TWO"] }]);
	assert.equal(out.ok, true);
	if (out.ok) {
		assert.deepEqual(out.lines, ["one", "TWO", "three"]);
		assert.equal(out.applied.length, 1);
	}
});

test("applyHashlineEdits: range replace + delete via lines null", () => {
	const lines = ["a", "b", "c", "d", "e"];
	const p = `2#${computeLineHash("b")}`;
	const e = `3#${computeLineHash("c")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos: p, end: e, lines: null }]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["a", "d", "e"]);

	const del = applyHashlineEdits(lines, [{ op: "replace", pos: p, lines: [] }]);
	assert.ok(del.ok);
	if (del.ok) assert.deepEqual(del.lines, ["a", "c", "d", "e"]);
});

test("applyHashlineEdits: append/prepend anchored, EOF and BOF", () => {
	const lines = ["x", "y"];
	const afterFirst = `1#${computeLineHash("x")}`;
	const out = applyHashlineEdits(lines, [{ op: "append", pos: afterFirst, lines: ["inserted"] }]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["x", "inserted", "y"]);

	const pre = applyHashlineEdits(lines, [{ op: "prepend", pos: afterFirst, lines: ["first"] }]);
	assert.ok(pre.ok);
	if (pre.ok) assert.deepEqual(pre.lines, ["first", "x", "y"]);

	const eof = applyHashlineEdits(lines, [{ op: "append", lines: ["tail"] }]);
	assert.ok(eof.ok);
	if (eof.ok) assert.deepEqual(eof.lines, ["x", "y", "tail"]);

	const bof = applyHashlineEdits(lines, [{ op: "prepend", lines: ["head"] }]);
	assert.ok(bof.ok);
	if (bof.ok) assert.deepEqual(bof.lines, ["head", "x", "y"]);
});

test("applyHashlineEdits: empty file creation via append", () => {
	const out = applyHashlineEdits([], [{ op: "append", lines: ["brand", "new"] }]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["brand", "new"]);
});

test("applyHashlineEdits: multiple ops apply bottom-up without anchor drift", () => {
	const lines = ["l1", "l2", "l3", "l4", "l5"];
	const a1 = `1#${computeLineHash("l1")}`;
	const a4 = `4#${computeLineHash("l4")}`;
	const a5 = `5#${computeLineHash("l5")}`;
	const out = applyHashlineEdits(lines, [
		{ op: "replace", pos: a1, lines: ["L1"] },
		{ op: "append", pos: a4, lines: ["after4"] },
		{ op: "replace", pos: a5, lines: ["L5"] },
	]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["L1", "l2", "l3", "l4", "after4", "L5"]);
});

test("applyHashlineEdits: overlapping replace ranges rejected", () => {
	const lines = ["a", "b", "c", "d"];
	const p1 = `1#${computeLineHash("a")}`;
	const p2 = `2#${computeLineHash("b")}`;
	const e3 = `3#${computeLineHash("c")}`;
	const out = applyHashlineEdits(lines, [
		{ op: "replace", pos: p1, end: e3, lines: ["x"] },
		{ op: "replace", pos: p2, lines: ["y"] },
	]);
	assert.equal(out.ok, false);
	if (!out.ok) assert.match(out.error, /overlap/);
});

test("applyHashlineEdits: stale anchor yields mismatch with corrected anchors", () => {
	const lines = ["one", "two-changed", "three"];
	const stale = `2#${computeLineHash("two-original")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos: stale, lines: ["nope"] }]);
	assert.equal(out.ok, false);
	if (!out.ok) {
		assert.equal(out.mismatch, true);
		assert.match(out.error, />>> mismatch/);
		assert.match(out.error, /2#[A-Z]{4}\|two-changed/);
	}
});

test("applyHashlineEdits: boundary echo dedup drops duplicated neighbors", () => {
	const lines = ["keep", "old", "keep-after"];
	const p = `2#${computeLineHash("old")}`;
	const e = `2#${computeLineHash("old")}`;
	const out = applyHashlineEdits(lines, [
		{ op: "replace", pos: p, end: e, lines: ["keep", "new", "keep-after"] },
	]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["keep", "new", "keep-after"]);
});

test("applyHashlineEdits: invalid anchor syntax rejected before any mutation", () => {
	const out = applyHashlineEdits(["a"], [{ op: "replace", pos: "not-an-anchor", lines: ["x"] }]);
	assert.equal(out.ok, false);
	if (!out.ok) assert.equal(out.mismatch, false);
});

test("applyHashlineEdits: beyond-EOF anchor reported as mismatch", () => {
	const lines = ["only"];
	const ref = `9#${computeLineHash("only")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos: ref, lines: ["x"] }]);
	assert.equal(out.ok, false);
	if (!out.ok) {
		assert.match(out.error, /beyond end of file/);
		assert.match(out.error, /that content is now at line 1/);
	}
});

test("normalizeEdits: infers missing op and copies inputs", () => {
	const out = normalizeEdits([
		{ pos: "2#ABCD", lines: ["x"] },
		{ lines: ["tail"] },
		{ op: "prepend", lines: ["head"] },
	]);
	assert.deepEqual(out, [
		{ op: "replace", pos: "2#ABCD", end: undefined, lines: ["x"] },
		{ op: "append", pos: undefined, end: undefined, lines: ["tail"] },
		{ op: "prepend", pos: undefined, end: undefined, lines: ["head"] },
	]);
});

test("applyHashlineEdits: reversed pos/end auto-swaps to the same span", () => {
	const lines = ["a", "b", "c"];
	const pos = `2#${computeLineHash("b")}`;
	const end = `1#${computeLineHash("a")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos, end, lines: ["X"] }]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["X", "c"]);
});

test("applyHashlineEdits: rebase remaps uniquely-moved anchors", () => {
	const lines = ["zero", "one", "two", "three"];
	const stale = `2#${computeLineHash("two")}`;
	const fail = applyHashlineEdits(lines, [{ op: "replace", pos: stale, lines: ["TWO"] }]);
	assert.equal(fail.ok, false);

	const out = applyHashlineEdits(lines, [{ op: "replace", pos: stale, lines: ["TWO"] }], {
		rebase: true,
	});
	assert.ok(out.ok);
	if (out.ok) {
		assert.deepEqual(out.lines, ["zero", "one", "TWO", "three"]);
		assert.equal(out.moved?.length, 1);
		assert.equal(out.moved?.[0]?.toLine, 3);
	}
});

test("applyHashlineEdits: rebase refuses ambiguous moved anchors", () => {
	const lines = ["x", "dup", "one", "dup"];
	const stale = `1#${computeLineHash("dup")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos: stale, lines: ["y"] }], {
		rebase: true,
	});
	assert.equal(out.ok, false);
	if (!out.ok) assert.equal(out.mismatch, true);
});

test("applyHashlineEdits: rebase on a 200-line fixture matches the golden remap", () => {
	const pad = (n) => String(n).padStart(3, "0");
	const original = Array.from({ length: 200 }, (_, i) => `line-${pad(i + 1)}`);
	const moves = [
		{ content: "line-010", target: 150 },
		{ content: "line-060", target: 5 },
		{ content: "line-190", target: 100 },
	];
	const movedSet = new Set(moves.map((m) => m.content));
	const current = original.filter((l) => !movedSet.has(l));
	for (const m of moves) current.splice(m.target - 1, 0, m.content);

	const ops = moves.map((m, i) => ({
		op: "replace",
		pos: `${original.indexOf(m.content) + 1}#${computeLineHash(m.content)}`,
		lines: [`EDIT-${pad(i + 1)}`],
	}));

	const out = applyHashlineEdits(current, ops, { rebase: true });
	assert.ok(out.ok);
	if (out.ok) {
		assert.deepEqual(out.moved, [
			{ ref: `10#${computeLineHash("line-010")}`, fromLine: 10, toLine: 152 },
			{ ref: `60#${computeLineHash("line-060")}`, fromLine: 60, toLine: 5 },
			{ ref: `190#${computeLineHash("line-190")}`, fromLine: 190, toLine: 100 },
		]);
		assert.equal(out.lines.length, 200);
		assert.equal(out.lines[151], "EDIT-001");
		assert.equal(out.lines[4], "EDIT-002");
		assert.equal(out.lines[99], "EDIT-003");
	}
});

test("verifyAnchors: duplicate refs report a single problem line", () => {
	const lines = ["one", "two-changed", "three"];
	const stale = `2#${computeLineHash("two-original")}`;
	const err = verifyAnchors(lines, [
		{ ref: stale, at: { line: 2, hash: computeLineHash("two-original") } },
		{ ref: stale, at: { line: 2, hash: computeLineHash("two-original") } },
	]);
	assert.ok(err);
	const hits = err.split("\n").filter((l) => l.includes(stale));
	assert.equal(hits.length, 1);
});

test("runFormatter: TORUS_FMT_CMD=true resolves async with the ok note", async () => {
	const prev = process.env.TORUS_FMT_CMD;
	process.env.TORUS_FMT_CMD = "true";
	const dir = mkdtempSync(join(tmpdir(), "hashline-fmt-"));
	try {
		const target = join(dir, "fixture.txt");
		writeFileSync(target, "alpha\n");
		const note = await runFormatter(target);
		assert.equal(note, "\nformatter: ok");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (prev === undefined) delete process.env.TORUS_FMT_CMD;
		else process.env.TORUS_FMT_CMD = prev;
	}
});

const NOTE_TEXT = "[hashline] writes files — re-read before hashline_edit.";

function makeToolResultHandler() {
	const handlers = {};
	registerHashline({
		on: (name, fn) => {
			handlers[name] = fn;
		},
		registerTool: () => {},
	});
	assert.equal(typeof handlers.tool_result, "function");
	return handlers.tool_result;
}

const bashResult = (command) => ({
	type: "tool_result",
	toolCallId: "bash-1",
	toolName: "bash",
	input: { command },
	content: [{ type: "text", text: "ok" }],
	details: undefined,
	isError: false,
});

const readResult = (text) => ({
	type: "tool_result",
	toolCallId: "read-1",
	toolName: "read",
	input: { path: "/w/fixture.ts" },
	content: [{ type: "text", text }],
	details: undefined,
	isError: false,
});

const editResult = (path) => ({
	type: "tool_result",
	toolCallId: "edit-1",
	toolName: "edit",
	input: { path },
	content: [{ type: "text", text: "done" }],
	details: undefined,
	isError: false,
});

const hashlineEditResult = (input, isError = false) => ({
	type: "tool_result",
	toolCallId: "hle-1",
	toolName: "hashline_edit",
	input,
	content: [{ type: "text", text: isError ? "mismatch" : "applied 1 op(s)" }],
	details: undefined,
	isError,
});

function lastText(result) {
	const texts = (result?.content ?? []).filter((b) => b.type === "text");
	return texts.at(-1)?.text;
}

test("tool_result notes: mutating bash results stay silent until a read arms anchors", () => {
	const handle = makeToolResultHandler();
	assert.equal(handle(bashResult("git checkout main")), undefined);
	assert.equal(handle(bashResult("npm install")), undefined);

	const read = handle(readResult("alpha\nbeta"));
	assert.ok(read);
	assert.match(read.content[0].text, /^1#[A-Z]{4}\|alpha\n2#[A-Z]{4}\|beta$/);

	const noted = handle(bashResult("cp a b"));
	assert.ok(noted);
	assert.equal(noted.content.length, 2);
	assert.deepEqual(noted.content[0], { type: "text", text: "ok" });
	assert.equal(lastText(noted), NOTE_TEXT);
});

test("tool_result notes: the bash mutation note fires once per arming", () => {
	const handle = makeToolResultHandler();
	handle(readResult("alpha\n"));
	assert.ok(handle(bashResult("mv a b")));
	assert.equal(handle(bashResult("rm c")), undefined);
	assert.equal(handle(bashResult("git stash")), undefined);
	handle(readResult("beta\n"));
	assert.ok(handle(bashResult("rm c")));
});

test("tool_result notes: successful hashline_edit re-arms, delete and errors do not", () => {
	const handle = makeToolResultHandler();
	handle(readResult("alpha\n"));
	assert.ok(handle(bashResult("cp a b")));
	assert.equal(
		handle(hashlineEditResult({ path: "/w/fixture.ts", edits: [{ op: "append", lines: ["x"] }] })),
		undefined,
	);
	assert.ok(handle(bashResult("git checkout main")));

	handle(readResult("beta\n"));
	assert.ok(handle(bashResult("cp a b")));
	handle(hashlineEditResult({ path: "/w/fixture.ts", delete: true }));
	assert.equal(handle(bashResult("rm c")), undefined);
	handle(
		hashlineEditResult({ path: "/w/fixture.ts", edits: [{ op: "append", lines: ["x"] }] }, true),
	);
	assert.equal(handle(bashResult("rm c")), undefined);
});

test("tool_result notes: /dev/null redirects and error results never note", () => {
	const handle = makeToolResultHandler();
	handle(readResult("alpha\n"));
	assert.equal(handle(bashResult("npm test > /dev/null 2>&1")), undefined);
	assert.equal(handle(bashResult("node x.js 2>/dev/null")), undefined);
	assert.equal(handle(bashResult("cmd >>/dev/null")), undefined);
	assert.equal(handle({ ...bashResult("cp a b"), isError: true }), undefined);
	assert.equal(handle({ ...readResult("x\n"), isError: true }), undefined);
	assert.ok(handle(bashResult("echo hi > /tmp/out")));
	assert.equal(handle(bashResult("echo hi >> build.log")), undefined);
	handle(readResult("beta"));
	assert.ok(handle(bashResult("echo hi >> build.log")));
});

test("tool_result notes: native edit results keep the per-file void notice", () => {
	const handle = makeToolResultHandler();
	const noted = handle(editResult("/w/fixture.ts"));
	assert.ok(noted);
	assert.equal(
		lastText(noted),
		"[hashline] anchors for /w/fixture.ts are void — re-read before hashline_edit.",
	);
});
