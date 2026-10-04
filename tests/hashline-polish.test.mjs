import assert from "node:assert/strict";
import { test } from "node:test";

const { applyHashlineEdits, computeLineHash, normalizeSubmittedLines } = await import(
	"../extensions/hashline/core.ts"
);

test("polish: array elements with embedded newlines are re-expanded", () => {
	assert.deepEqual(normalizeSubmittedLines(["a\nb", "c"]), ["a", "b", "c"]);
	assert.deepEqual(normalizeSubmittedLines("x\ny"), ["x", "y"]);
});

test("polish: unindented replacement of an indented range restores the base indent", () => {
	const lines = ["function f() {", "\tlet a = 1;", "\tlet b = 2;", "}"];
	const p = `2#${computeLineHash("\tlet a = 1;")}`;
	const e = `3#${computeLineHash("\tlet b = 2;")}`;
	const out = applyHashlineEdits(lines, [
		{ op: "replace", pos: p, end: e, lines: ["let a = 10;", "let b = 20;"] },
	]);
	assert.ok(out.ok);
	if (out.ok) {
		assert.deepEqual(out.lines, ["function f() {", "\tlet a = 10;", "\tlet b = 20;", "}"]);
		assert.deepEqual(
			out.applied[0]?.added,
			["\tlet a = 10;", "\tlet b = 20;"],
			"added carries the final applied lines",
		);
		assert.deepEqual(
			out.applied[0]?.removed,
			["\tlet a = 1;", "\tlet b = 2;"],
			"removed captures the consumed range",
		);
	}
});

test("polish: already-indented submissions are not re-indented", () => {
	const lines = ["{", "\tvalue = 1;", "}"];
	const p = `2#${computeLineHash("\tvalue = 1;")}`;
	const out = applyHashlineEdits(lines, [{ op: "replace", pos: p, lines: ["\tvalue = 2;"] }]);
	assert.ok(out.ok);
	if (out.ok) assert.equal(out.lines[1], "\tvalue = 2;");
});

test("polish: mixed indentation in the consumed range leaves submissions untouched", () => {
	const lines = ["start", "  twoSpaces", "\tfourTab", "end"];
	const p = `2#${computeLineHash("  twoSpaces")}`;
	const e = `3#${computeLineHash("\tfourTab")}`;
	const out = applyHashlineEdits(lines, [
		{ op: "replace", pos: p, end: e, lines: ["flat one", "flat two"] },
	]);
	assert.ok(out.ok);
	if (out.ok) assert.deepEqual(out.lines, ["start", "flat one", "flat two", "end"]);
});

test("polish: insert ops report empty removed and their added lines", () => {
	const lines = ["x"];
	const out = applyHashlineEdits(lines, [{ op: "append", lines: ["y", "z"] }]);
	assert.ok(out.ok);
	if (out.ok) {
		assert.deepEqual(out.applied[0]?.removed, []);
		assert.deepEqual(out.applied[0]?.added, ["y", "z"]);
	}
});
