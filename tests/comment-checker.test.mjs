import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const {
	addedLinesForEdit,
	addedLinesForWrite,
	findCommentedLines,
	commentPrefixesFor,
	registerCommentChecker,
} = await import("../extensions/comment-checker/index.ts");
const { writeBlockReason } = await import("../extensions/guards/index.ts");
const { _readCacheStats } = await import("../extensions/fsutil.ts");

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

test("write capture shares the write guard's cached disk read (one miss per path per process)", () => {
	const prev = process.env.TORUS_COMMENT_CHECKER;
	process.env.TORUS_COMMENT_CHECKER = "1";
	try {
		const base = realpathSync(tmpdir());
		const dir = mkdtempSync(path.join(base, "torus-comment-cache-"));
		const file = path.join(dir, "mod.ts");
		const disk = [];
		for (let i = 0; i < 12; i++) disk.push(`const v${i} = ${i};`);
		writeFileSync(file, `${disk.join("\n")}\n`, "utf8");

		const handlers = {};
		registerCommentChecker({ on: (name, fn) => (handlers[name] = fn) });
		assert.equal(typeof handlers.tool_call, "function", "capture handler registered");

		const before = _readCacheStats();
		const guardReason = writeBlockReason(
			file,
			"// added by hand\nconst x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\n",
		);
		handlers.tool_call({
			type: "tool_call",
			toolName: "write",
			input: { path: file, content: "// added by hand\nconst x = 1;\n" },
			toolCallId: "cc-cache-1",
		});
		const after = _readCacheStats();
		assert.equal(guardReason, null, "fixture: the rewrite is not near-identical, guard allows it");
		assert.equal(after.misses, before.misses + 1, "guard + comment checker consume ONE disk read");
		assert.ok(after.hits >= before.hits + 1, "the second consumer is a cache hit");
	} finally {
		if (prev === undefined) delete process.env.TORUS_COMMENT_CHECKER;
		else process.env.TORUS_COMMENT_CHECKER = prev;
	}
});
