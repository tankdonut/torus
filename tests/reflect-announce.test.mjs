import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// TORUS_HOME must land before the memory import — it derives store paths at
// module load.
const home = mkdtempSync(path.join(tmpdir(), "torus-reflect-announce-"));
process.env.TORUS_HOME = home;

const memory = await import("../extensions/memory/index.ts");

test("background start markers are neutral third-person text", () => {
	for (const text of [memory.REFLECT_ANNOUNCE, memory.DREAM_ANNOUNCE]) {
		assert.equal(typeof text, "string");
		assert.ok(text.length > 0);
		assert.doesNotMatch(
			text,
			/^you/i,
			"marker must not read as an instruction to the parent model",
		);
		assert.match(text, /dreamer/i);
		assert.match(text, /no action needed/i);
	}
});

test("reflectOpening matches how reflection was triggered", () => {
	assert.match(memory.reflectOpening("idle"), /just-idled/);
	assert.match(memory.reflectOpening("idle"), /You are reflecting/);
	const turns = memory.reflectOpening("turns");
	assert.match(turns, /turn threshold/);
	assert.match(turns, /You are reflecting/);
	assert.doesNotMatch(turns, /just-idled/, "a turn-triggered run did not idle");
});
