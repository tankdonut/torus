import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-dream-applied-"));
process.env["TORUS_HOME"] = home;

const memory = await import("../extensions/memory/index.ts");

test("applyDreamProposal reports per-kind counts and applies the store changes", () => {
	try {
		const seed = memory.applyDreamProposal({
			entries: [{ topic: "Seed lesson", body: "body text", tags: ["t"], project: "global" }],
			deletes: [],
			profiles: [],
		});
		assert.deepEqual(seed, {
			entries: 1,
			deletes: 0,
			profile: 0,
			entryTopics: ["Seed lesson"],
			deletedFiles: [],
		});

		const entriesDir = path.join(home, "memory", "entries");
		const seeded = readdirSync(entriesDir).find((f) => f.endsWith(".md"));
		assert.ok(seeded, "seed entry written");

		const counts = memory.applyDreamProposal({
			entries: [{ topic: "Second lesson", body: "b", tags: [], project: "global" }],
			deletes: [seeded ?? "", "no-such.md"],
			profiles: ["profile line one"],
		});
		assert.deepEqual(counts, {
			entries: 1,
			deletes: 1,
			profile: 1,
			entryTopics: ["Second lesson"],
			deletedFiles: [seeded ?? ""],
		});
		assert.equal(existsSync(path.join(entriesDir, seeded ?? "")), false, "seeded entry deleted");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("dreamAppliedLine summarizes counts, names, and the no-change case", () => {
	assert.equal(
		memory.dreamAppliedLine(
			{ entries: 2, deletes: 1, profile: 1, entryTopics: ["a", "b"], deletedFiles: ["c.md"] },
			"dream",
		),
		"dream applied · +2 entries (a; b) · −1 delete (c.md) · profile +1",
	);
	assert.equal(
		memory.dreamAppliedLine(
			{ entries: 1, deletes: 0, profile: 0, entryTopics: ["x"], deletedFiles: [] },
			"reflect",
		),
		"reflect applied · +1 entry (x) · −0 deletes · profile +0",
	);
	assert.equal(
		memory.dreamAppliedLine(memory.emptyApplied(), "reflect"),
		"reflect complete · no changes",
	);
});
