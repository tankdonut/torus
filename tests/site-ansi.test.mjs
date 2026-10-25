import assert from "node:assert/strict";
import { test } from "node:test";
import { cropLines, parseAnsiScreen } from "../site/src/lib/ansi.mjs";

const strip = (runs) => runs.map((r) => r.text).join("");
const styleOf = (lines, i = 0) => {
	const run = lines[i]?.[0] ?? {};
	return { fg: run.fg, bold: run.bold, inverse: run.inverse };
};

test("plain text parses into unstyled runs", () => {
	const lines = parseAnsiScreen("hello\nworld");
	assert.deepEqual(lines.map(strip), ["hello", "world"]);
	assert.deepEqual(lines[0][0], { text: "hello" });
});

test("truecolor fg and reset produce styled then default runs", () => {
	const lines = parseAnsiScreen("\x1b[38;2;126;136;142mgray\x1b[39m plain");
	assert.equal(lines[0][0].fg, "rgb(126,136,142)");
	assert.equal(lines[0][0].text, "gray");
	assert.equal(lines[0][1].text, " plain");
	assert.equal(lines[0][1].fg, undefined);
});

test("style state carries across lines until reset", () => {
	const lines = parseAnsiScreen("\x1b[38;2;86;182;194mone\ntwo\x1b[0mthree");
	assert.equal(lines[0][0].fg, "rgb(86,182,194)");
	assert.equal(lines[1][0].fg, "rgb(86,182,194)");
	assert.equal(lines[1][0].text, "two");
	assert.equal(lines[1][1].text, "three");
	assert.equal(lines[1][1].fg, undefined);
});

test("adjacent same-style runs merge", () => {
	const lines = parseAnsiScreen("\x1b[1ma\x1b[1mb\x1b[22mc");
	assert.equal(lines[0].length, 2);
	assert.deepEqual(lines[0][0], { text: "ab", bold: true });
	assert.equal(lines[0][1].text, "c");
});

test("SGR 0 clears every attribute", () => {
	const lines = parseAnsiScreen("\x1b[1;3;7mstyled\x1b[0mplain");
	assert.deepEqual(styleOf(lines), { fg: undefined, bold: true, inverse: true });
	assert.equal(lines[0][0].italic, true);
	assert.equal(lines[0][1].bold, undefined);
	assert.equal(lines[0][1].inverse, undefined);
});

test("256-color and palette codes resolve", () => {
	const lines = parseAnsiScreen("\x1b[38;5;244mgrey\x1b[0m\x1b[91mred\x1b[0m\x1b[48;5;21mend");
	assert.equal(lines[0][0].fg, "rgb(128,128,128)");
	assert.equal(lines[0][1].fg, "#ff0000");
	assert.equal(lines[0][2].bg, "rgb(0,0,255)");
	assert.deepEqual(
		lines[0].map((r) => r.text),
		["grey", "red", "end"],
	);
});

test("non-SGR CSI and OSC sequences are stripped, text survives", () => {
	const lines = parseAnsiScreen("a\x1b[2Jb\x1b]0;title\x07c\x1b[?25hd");
	assert.deepEqual(strip(lines[0]), "abcd");
});

test("cropLines trims blank edges and keeps requested windows", () => {
	const raw = "\n\na\nb\n\n\n";
	assert.deepEqual(cropLines(parseAnsiScreen(raw)).map(strip), ["a", "b"]);
	assert.deepEqual(cropLines(parseAnsiScreen(raw), { keepLast: 1 }).map(strip), ["b"]);
	assert.deepEqual(cropLines(parseAnsiScreen(raw), { from: -1 }).map(strip), ["b"]);
});

test("cropLines negative from/to index from the trimmed end", () => {
	const lines = parseAnsiScreen("one\ntwo\nthree");
	assert.deepEqual(cropLines(lines, { from: -2, to: -1 }).map(strip), ["two"]);
});
