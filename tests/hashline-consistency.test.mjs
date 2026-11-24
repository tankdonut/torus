import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { anchorAll, applyHashlineEdits, computeLineHash } = await import(
	"../extensions/hashline/core.ts"
);
const { registerHashline } = await import("../extensions/hashline/index.ts");

process.env.TORUS_STATE_DIR ??= tmpdir();

const captured = {};
registerHashline({
	on: (event, fn) => {
		captured[event] = fn;
	},
	registerTool: (tool) => {
		captured.tool = tool;
	},
});
const hook = captured["tool_result"];
const tool = captured.tool;

function anchorMap(text, input = {}) {
	const out = hook({ toolName: "read", isError: false, input, content: [{ type: "text", text }] });
	if (!out) return null;
	const map = {};
	for (const line of out.content[0].text.split("\n")) {
		const m = /^(\d+)#([A-Z]{4})\|(.*)$/.exec(line);
		if (m) map[m[3]] = `${m[1]}#${m[2]}`;
	}
	return { map, text: out.content[0].text };
}

test("anchorAll: startLine numbers the window from a true file offset", () => {
	const anchored = anchorAll(["x", "y"], 41);
	assert.match(anchored[0] ?? "", /^41#[A-Z]{4}\|x$/);
	assert.match(anchored[1] ?? "", /^42#[A-Z]{4}\|y$/);
});

test("read hook: offset reads carry absolute anchors, notices stay bare", () => {
	const text =
		["line 6", "line 7", "line 8"].join("\n") +
		"\n\n[4 more lines in file. Use offset=9 to continue.]";
	const out = hook({
		toolName: "read",
		isError: false,
		input: { path: "/f", offset: 6, limit: 3 },
		content: [{ type: "text", text }],
	});
	const lines = out.content[0].text.split("\n");
	assert.match(lines[0] ?? "", /^6#[A-Z]{4}\|line 6$/);
	assert.match(lines[2] ?? "", /^8#[A-Z]{4}\|line 8$/);
	assert.equal(lines[3] ?? "", "");
	assert.equal(lines[4] ?? "", "[4 more lines in file. Use offset=9 to continue.]");
});

test("read hook: every engine notice format is skipped, full reads stay 1-based", () => {
	for (const notice of [
		"[Showing lines 201-400 of 321. Use offset=401 to continue.]",
		"[Showing lines 201-400 of 321 (50KB limit). Use offset=401 to continue.]",
		"[Line 205 is 60KB, exceeds 50KB limit. Use bash: sed -n '205p' f | head -c 50KB]",
	]) {
		const out = hook({
			toolName: "read",
			isError: false,
			input: { path: "/f" },
			content: [{ type: "text", text: ["a", "b", "", notice].join("\n") }],
		});
		assert.ok(out);
		assert.doesNotMatch(out.content[0].text, /#\w+\|\[/, notice);
		assert.match(out.content[0].text, /^1#[A-Z]{4}\|a$/m);
	}
});

test("read hook: empty and notice-only text pass through untouched", () => {
	const empty = hook({
		toolName: "read",
		isError: false,
		input: { path: "/f" },
		content: [{ type: "text", text: "" }],
	});
	assert.equal(empty, undefined);
	const noticeOnly = hook({
		toolName: "read",
		isError: false,
		input: { path: "/f" },
		content: [{ type: "text", text: "[Line 2 is 60KB, exceeds 50KB limit. Use bash: x]" }],
	});
	assert.equal(noticeOnly, undefined);
});

test("tool: an anchor copied from an offset read edits the right line", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hashline-offset-"));
	try {
		const file = join(dir, "f.txt");
		writeFileSync(file, `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
		const { map } = anchorMap(["line 6", "line 7", "line 8"].join("\n"), {
			path: file,
			offset: 6,
			limit: 3,
		});
		const res = await tool.execute("t", {
			path: file,
			edits: [{ pos: map["line 7"], lines: "SEVEN" }],
		});
		assert.equal(res.isError, undefined);
		assert.equal(readFileSync(file, "utf8").split("\n")[6], "SEVEN");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool: per-edit regions show final line coordinates after net shifts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hashline-regions-"));
	try {
		const file = join(dir, "f.txt");
		const src = `${["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n")}\n`;
		writeFileSync(file, src);
		const { map } = anchorMap(src);
		const res = await tool.execute("t", {
			path: file,
			edits: [
				{ pos: map["two"], lines: ["two-a", "two-b", "two-c"] },
				{ pos: map["six"], lines: "SIX-EDITED" },
			],
		});
		assert.equal(res.isError, undefined);
		const regionBlock = res.content[0].text.split("\n\n")[1] ?? "";
		const six = /^(\d+)#[A-Z]{4}\|SIX-EDITED$/m.exec(regionBlock);
		assert.equal(six?.[1], "8", "SIX-EDITED sits at final line 8, displayed as 8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("core: final coordinates on AppliedEdit account for deletes above", () => {
	const lines = ["a", "b", "c", "d", "e"];
	const out = applyHashlineEdits(lines, [
		{
			op: "replace",
			pos: `1#${computeLineHash("a")}`,
			end: `2#${computeLineHash("b")}`,
			lines: null,
		},
		{ op: "replace", pos: `4#${computeLineHash("d")}`, lines: ["D"] },
	]);
	assert.ok(out.ok);
	if (out.ok) {
		const insert = out.applied.find((e) => e.label === "replace 4");
		assert.deepEqual([insert?.from, insert?.to], [2, 2]);
	}
});

test("core: lines is required — omission errors instead of deleting", () => {
	const lines = ["a", "b"];
	const missing = applyHashlineEdits(lines, [{ op: "replace", pos: `2#${computeLineHash("b")}` }]);
	assert.ok(!missing.ok);
	if (!missing.ok) assert.match(missing.error, /needs "lines"/);

	const emptyInsert = applyHashlineEdits(lines, [{ op: "append", lines: [] }]);
	assert.ok(!emptyInsert.ok);
	if (!emptyInsert.ok) assert.match(emptyInsert.error, /at least one line/);
});

test("core: inserts honor end as the anchor when pos is absent", () => {
	const lines = ["a", "b", "c"];
	const out = applyHashlineEdits(lines, [
		{ op: "append", end: `2#${computeLineHash("b")}`, lines: ["AFTER-B"] },
	]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["a", "b", "AFTER-B", "c"]);

	const both = applyHashlineEdits(lines, [
		{
			op: "prepend",
			pos: `1#${computeLineHash("a")}`,
			end: `2#${computeLineHash("b")}`,
			lines: ["x"],
		},
	]);
	assert.ok(!both.ok);
	if (!both.ok) assert.match(both.error, /ONE anchor line/);
});

test("core: mismatch classification — moved, vanished, ambiguous", () => {
	const lines = ["head", "x", "y", "target-line", "tail"];
	const moved = applyHashlineEdits(lines, [
		{ op: "replace", pos: `2#${computeLineHash("target-line")}`, lines: ["z"] },
	]);
	assert.ok(!moved.ok);
	if (!moved.ok) {
		assert.match(moved.error, /content moved — now at line 4/);
		assert.match(moved.error, /rebase:true/);
	}

	const vanished = applyHashlineEdits(lines, [{ op: "replace", pos: "2#AAAA", lines: ["z"] }]);
	assert.ok(!vanished.ok);
	if (!vanished.ok) assert.match(vanished.error, /no line in this file carries that hash/);

	const dup = ["dup", "one", "dup"];
	const ambiguous = applyHashlineEdits(dup, [
		{ op: "replace", pos: `2#${computeLineHash("dup")}`, lines: ["z"] },
	]);
	assert.ok(!ambiguous.ok);
	if (!ambiguous.ok) assert.match(ambiguous.error, /content appears at lines 1, 3/);
});

test("core: uniform indent swap is normalized and flagged; matching indent is not", () => {
	const lines = ["function f() {", "\tbody;", "}"];
	const swapped = applyHashlineEdits(lines, [
		{ op: "replace", pos: `2#${computeLineHash("\tbody;")}`, lines: ["  spaced();"] },
	]);
	assert.ok(swapped.ok);
	if (swapped.ok) {
		assert.deepEqual(swapped.lines, ["function f() {", "\tspaced();", "}"]);
		assert.equal(swapped.applied[0]?.indentAdjusted, true);
	}

	const kept = applyHashlineEdits(lines, [
		{ op: "replace", pos: `2#${computeLineHash("\tbody;")}`, lines: ["\tother();"] },
	]);
	assert.ok(kept.ok);
	if (kept.ok) assert.equal(kept.applied[0]?.indentAdjusted, undefined);
});

test("tool: indent normalization is flagged in the region label", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hashline-indent-"));
	try {
		const file = join(dir, "f.ts");
		const src = `${["function f() {", "\tbody;", "}"].join("\n")}\n`;
		writeFileSync(file, src);
		const { map } = anchorMap(src);
		const res = await tool.execute("t", {
			path: file,
			edits: [{ pos: map["\tbody;"], lines: ["  spaced();"] }],
		});
		assert.equal(res.isError, undefined);
		assert.match(res.content[0].text, /\[indent normalized\]/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool: creating a file writes exact content with no leading blank", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hashline-create-"));
	try {
		const file = join(dir, "new.ts");
		const res = await tool.execute("t", { path: file, edits: [{ lines: ["alpha", "beta"] }] });
		assert.equal(res.isError, undefined);
		assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\n");

		const empty = join(dir, "empty.ts");
		writeFileSync(empty, "", "utf8");
		await tool.execute("t", { path: empty, edits: [{ lines: ["first"] }] });
		assert.equal(readFileSync(empty, "utf8"), "first\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hook: write-ish bash results carry a re-read note, read-only ones do not", () => {
	// Anchors must be live for the note to fire, so arm before each command:
	// the verdict under test is the regex classification, not the gating.
	const arm = () =>
		hook({
			toolName: "read",
			isError: false,
			input: { path: "/f" },
			content: [{ type: "text", text: "arm" }],
		});
	const note = (command) =>
		hook({
			toolName: "bash",
			isError: false,
			input: { command },
			content: [{ type: "text", text: "ok" }],
		});
	for (const cmd of [
		"sed -i 's/a/b/' f.ts",
		"sed -ibak s/a/b/ f.ts",
		"perl -pi -e 's/a/b/' f.ts",
		"echo hi > out.txt",
		"echo hi >> out.txt",
		"node t.mjs 2> out.log",
		"npm test 2>> test.log",
		"tee out.txt",
		"cp a b",
		"git checkout main -- src/",
		"git apply patch.diff",
		"git restore src/",
		"git stash pop",
		"npm install lodash",
		"pnpm add lodash",
		"mv a b",
	]) {
		arm();
		const out = note(cmd);
		assert.ok(out !== undefined, cmd);
		assert.match(
			out.content.at(-1).text,
			/\[hashline\] writes files — re-read before hashline_edit\./,
			cmd,
		);
	}
	for (const cmd of [
		"ls -la",
		"grep -rn foo src/",
		"node t.mjs 2>&1 | head",
		"npm test",
		"test 1 -eq 1",
		"npm test > /dev/null 2>&1",
		"node t.mjs 2>/dev/null",
	]) {
		arm();
		assert.equal(note(cmd), undefined, cmd);
	}
	assert.equal(
		hook({ toolName: "bash", isError: true, input: { command: "sed -i s/a/b/ f" }, content: [] }),
		undefined,
		"failed commands carry no note",
	);
});

test("hook: native edit/write still get the void note", () => {
	for (const toolName of ["edit", "write"]) {
		const out = hook({
			toolName,
			isError: false,
			input: { path: "/x/y.ts" },
			content: [{ type: "text", text: "ok" }],
		});
		assert.match(out.content.at(-1).text, /anchors for \/x\/y\.ts are void/);
	}
});

test("core: rebase aborts when remapped range endpoints invert", () => {
	const disk = ["A", "C", "D", "B"];
	const out = applyHashlineEdits(
		disk,
		[
			{
				op: "replace",
				pos: `2#${computeLineHash("B")}`,
				end: `3#${computeLineHash("C")}`,
				lines: ["X", "Y"],
			},
		],
		{ rebase: true },
	);
	assert.equal(out.ok, false);
	if (!out.ok) {
		assert.equal(out.mismatch, true);
		assert.match(out.error, />>> mismatch/);
	}
});

test("core: anchorless inserts in a batch report final coordinates", () => {
	const lines = ["a", "b", "c"];
	const prependBatch = applyHashlineEdits(lines, [
		{ op: "prepend", lines: ["H1", "H2"] },
		{ op: "replace", pos: `2#${computeLineHash("b")}`, lines: ["REPL"] },
	]);
	assert.ok(prependBatch.ok);
	if (prependBatch.ok) {
		assert.deepEqual(prependBatch.lines, ["H1", "H2", "a", "REPL", "c"]);
		const repl = prependBatch.applied.find((e) => e.label === "replace 2");
		assert.deepEqual([repl?.from, repl?.to], [4, 4]);
	}

	const appendBatch = applyHashlineEdits(lines, [
		{ op: "append", lines: ["T"] },
		{ op: "replace", pos: `1#${computeLineHash("a")}`, lines: ["R1", "R2"] },
	]);
	assert.ok(appendBatch.ok);
	if (appendBatch.ok) {
		assert.deepEqual(appendBatch.lines, ["R1", "R2", "b", "c", "T"]);
		const tail = appendBatch.applied.find((e) => e.label === "insert after 3");
		assert.deepEqual([tail?.from, tail?.to], [5, 5]);
	}
});

test("read hook: offset sanitization falls back to 1 for zero and negative, floors fractional", () => {
	for (const offset of [0, -3]) {
		const out = hook({
			toolName: "read",
			isError: false,
			input: { path: "/f", offset },
			content: [{ type: "text", text: "x\ny" }],
		});
		assert.match(out.content[0].text, /^1#[A-Z]{4}\|x$/m, `offset ${offset}`);
	}
	const floored = hook({
		toolName: "read",
		isError: false,
		input: { path: "/f", offset: 2.5 },
		content: [{ type: "text", text: "x\ny" }],
	});
	assert.match(floored.content[0].text, /^2#[A-Z]{4}\|x$/m);
});

test("read hook: error results and image notes pass through untouched", () => {
	assert.equal(
		hook({
			toolName: "read",
			isError: true,
			input: { path: "/f" },
			content: [{ type: "text", text: "Error: boom" }],
		}),
		undefined,
	);
	const mixed = hook({
		toolName: "read",
		isError: false,
		input: { path: "/f" },
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "text", text: "real line" },
		],
	});
	const texts = mixed.content.filter((b) => b.type === "text");
	assert.equal(texts[0].text, "Read image file [image/png]");
	assert.match(texts[1].text, /^1#[A-Z]{4}\|real line$/);
});

test("core: end-anchored inserts apply at their anchor line inside mixed batches", () => {
	const out = applyHashlineEdits(
		["1", "2", "3", "4", "5"],
		[
			{ op: "append", end: `2#${computeLineHash("2")}`, lines: ["INS"] },
			{ op: "replace", pos: `3#${computeLineHash("3")}`, lines: ["R"] },
		],
	);
	assert.ok(out.ok);
	if (out.ok) {
		assert.deepEqual(out.lines, ["1", "2", "INS", "R", "4", "5"]);
		const insert = out.applied.find((e) => e.label === "insert after 2");
		assert.deepEqual([insert?.from, insert?.to], [3, 3]);
	}

	const inside = applyHashlineEdits(
		["1", "2", "3", "4", "5", "6", "7", "8", "9"],
		[
			{ op: "append", end: `5#${computeLineHash("5")}`, lines: ["X"] },
			{
				op: "replace",
				pos: `3#${computeLineHash("3")}`,
				end: `8#${computeLineHash("8")}`,
				lines: ["R"],
			},
		],
	);
	assert.ok(!inside.ok);
	if (!inside.ok) assert.match(inside.error, /strictly inside a replaced range/);
});

test("core: stacked EOF appends and same-line pairs report true final coordinates", () => {
	const stacked = applyHashlineEdits(
		["a"],
		[
			{ op: "append", lines: ["X1", "X2"] },
			{ op: "append", lines: ["Y1", "Y2"] },
		],
	);
	assert.ok(stacked.ok);
	if (stacked.ok) {
		assert.deepEqual(stacked.lines, ["a", "X1", "X2", "Y1", "Y2"]);
		const x = stacked.applied[0];
		const y = stacked.applied[1];
		assert.deepEqual([x?.from, x?.to], [2, 3]);
		assert.deepEqual([y?.from, y?.to], [4, 5]);
	}

	const sameLine = applyHashlineEdits(
		["a", "b", "c"],
		[
			{ op: "replace", pos: `2#${computeLineHash("b")}`, lines: ["R1", "R2"] },
			{ op: "append", pos: `2#${computeLineHash("b")}`, lines: ["INS"] },
		],
	);
	assert.ok(sameLine.ok);
	if (sameLine.ok) {
		assert.deepEqual(sameLine.lines, ["a", "R1", "R2", "INS", "c"]);
		const repl = sameLine.applied.find((e) => e.label === "replace 2");
		const ins = sameLine.applied.find((e) => e.label === "insert after 2");
		assert.deepEqual([repl?.from, repl?.to], [2, 3]);
		assert.deepEqual([ins?.from, ins?.to], [4, 4]);
	}
});

test("core: rebase reports a moved anchor once and aborts same-line divergence", () => {
	const ref = `3#${computeLineHash("target")}`;
	const out = applyHashlineEdits(
		["head", "x", "y", "target", "tail"],
		[{ op: "replace", pos: ref, end: ref, lines: ["z"] }],
		{ rebase: true },
	);
	assert.ok(out.ok);
	if (out.ok) assert.equal(out.moved?.length, 1);

	const diverged = applyHashlineEdits(
		["x", "y", "b"],
		[
			{
				op: "append",
				pos: `2#${computeLineHash("b")}`,
				end: `2#${computeLineHash("y")}`,
				lines: ["INS"],
			},
		],
		{ rebase: true },
	);
	assert.ok(!diverged.ok);
	if (!diverged.ok) assert.equal(diverged.mismatch, true);
});

test("core: beyond-EOF anchors list every line still carrying the content", () => {
	const out = applyHashlineEdits(
		["dup", "one", "dup"],
		[{ op: "replace", pos: `9#${computeLineHash("dup")}`, lines: ["x"] }],
	);
	assert.ok(!out.ok);
	if (!out.ok) assert.match(out.error, /that content is now at lines 1, 3/);
});

test("core: boundary-tie pairs and stacked prepends report true final coordinates", () => {
	const boundary = applyHashlineEdits(
		["1", "2", "3", "4", "5"],
		[
			{ op: "append", pos: `4#${computeLineHash("4")}`, lines: ["A1", "A2", "A3"] },
			{ op: "prepend", pos: `5#${computeLineHash("5")}`, lines: ["B"] },
		],
	);
	assert.ok(boundary.ok);
	if (boundary.ok) {
		assert.deepEqual(boundary.lines, ["1", "2", "3", "4", "A1", "A2", "A3", "B", "5"]);
		const ins = boundary.applied.find((e) => e.label === "insert after 4");
		const pre = boundary.applied.find((e) => e.label === "insert before 5");
		assert.deepEqual([ins?.from, ins?.to], [5, 7]);
		assert.deepEqual([pre?.from, pre?.to], [8, 8]);
	}

	const stacked = applyHashlineEdits(
		["a", "b"],
		[
			{ op: "prepend", lines: ["P1"] },
			{ op: "prepend", lines: ["P2"] },
		],
	);
	assert.ok(stacked.ok);
	if (stacked.ok) {
		assert.deepEqual(stacked.lines, ["P2", "P1", "a", "b"]);
		const first = stacked.applied[0];
		const second = stacked.applied[1];
		assert.deepEqual([first?.from, first?.to], [2, 2]);
		assert.deepEqual([second?.from, second?.to], [1, 1]);
	}
});
