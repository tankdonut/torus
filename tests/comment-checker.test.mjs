import assert from "node:assert/strict";
import { test } from "node:test";

const { addedLinesForEdit, addedLinesForWrite, findCommentedLines, commentPrefixesFor } =
	await import("../extensions/comment-checker/index.ts");

test("addedLinesForEdit: only genuinely new lines count", () => {
	const added = addedLinesForEdit([
		{ oldText: "const a = 1;", newText: "const a = 1;\n// why\nconst b = 2;" },
	]);
	assert.deepEqual(added, ["// why", "const b = 2;"]);
});

test("addedLinesForEdit: reindented existing lines are not 'added'", () => {
	const added = addedLinesForEdit([
		{ oldText: "if (x) {\n\treturn 1;\n}", newText: "if (x) {\n  return 1;\n}" },
	]);
	assert.deepEqual(added, []);
});

test("addedLinesForWrite: diff against disk content", () => {
	const added = addedLinesForWrite("keep()\n// new note\nnew()", "keep()\nold()");
	assert.deepEqual(added, ["// new note", "new()"]);
	assert.deepEqual(addedLinesForWrite("a", null), ["a"]);
});

test("findCommentedLines: per-language prefixes detected", () => {
	assert.deepEqual(findCommentedLines(["// line", "code()", "# not ts"], "a.ts"), ["// line"]);
	assert.deepEqual(findCommentedLines(["# py", "x = 1"], "a.py"), ["# py"]);
	assert.deepEqual(findCommentedLines(["-- sql", "SELECT 1;"], "a.sql"), ["-- sql"]);
	assert.deepEqual(findCommentedLines(["<!-- html -->", "<p/>"], "a.html"), ["<!-- html -->"]);
	assert.deepEqual(findCommentedLines(['" vim', "set nu"], "a.vim"), ['" vim']);
});

test("findCommentedLines: trailing comments detected, URLs are not", () => {
	assert.deepEqual(findCommentedLines(["const u = fetch(url); // retry twice"], "a.ts"), [
		"const u = fetch(url); // retry twice",
	]);
	assert.deepEqual(findCommentedLines(["const u = 'https://example.com/x';"], "a.ts"), []);
	assert.deepEqual(findCommentedLines(["curl https://host/path # fragment"], "a.sh"), [
		"curl https://host/path # fragment",
	]);
});

test("findCommentedLines: unknown extensions and empty prefixes are skipped", () => {
	assert.deepEqual(findCommentedLines(["# whatever"], "a.unknownext"), []);
	assert.deepEqual(commentPrefixesFor("noext"), []);
});
