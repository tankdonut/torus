import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

test("sessionActivityLogs scopes idle reflection to the invoking session only", () => {
	const mine = [
		{ parentSession: "sess-a", startedAt: 300, logFile: "/logs/a3.log" },
		{ parentSession: "sess-a", startedAt: 100, logFile: "/logs/a1.log" },
		{ parentSession: "sess-a", startedAt: 200, logFile: "/logs/a2.log" },
	];
	const foreign = [{ parentSession: "sess-b", startedAt: 400, logFile: "/logs/b-newest.log" }];
	const parentless = [
		{ parentSession: null, startedAt: 500, logFile: "/logs/reflect-dreamer.log" },
	];

	// newest first, capped at 3, foreign sessions never included even when newer
	assert.deepEqual(memory.sessionActivityLogs([...foreign, ...mine], "sess-a"), [
		"/logs/a3.log",
		"/logs/a2.log",
		"/logs/a1.log",
	]);
	assert.deepEqual(memory.sessionActivityLogs([...parentless, ...foreign], "sess-a"), []);
	assert.deepEqual(memory.sessionActivityLogs([...mine.slice(0, 2)], "sess-a", 1), [
		"/logs/a3.log",
	]);
});

test("reflectDecision matrix: trigger × threshold × settles × inFlight", () => {
	const decide = (trigger, settlesSinceLastReflect, threshold, inFlight) =>
		memory.reflectDecision({ trigger, settlesSinceLastReflect, threshold, inFlight }).reflect;

	for (const trigger of ["idle", "turns"]) {
		for (const threshold of [0, 2, 12]) {
			const settleCases = [
				...new Set([0, 1, ...(threshold > 1 ? [threshold - 1] : []), threshold]),
			];
			for (const settles of settleCases) {
				for (const inFlight of [false, true]) {
					const label = `${trigger}/threshold ${threshold}/settles ${settles}/inFlight ${inFlight}`;
					if (inFlight) assert.equal(decide(trigger, settles, threshold, true), false, label);
					else if (trigger === "idle")
						assert.equal(decide("idle", settles, threshold, false), settles >= 1, label);
					else if (threshold <= 0)
						assert.equal(decide("turns", settles, threshold, false), false, label);
					else
						assert.equal(decide("turns", settles, threshold, false), settles >= threshold, label);
				}
			}
		}
	}

	assert.equal(decide("turns", 2, 2, false), true, "turns/2/2 → true");
	assert.equal(decide("turns", 1, 2, false), false, "turns/2/1 → false");
	assert.equal(decide("turns", 5, 0, false), false, "turns/0/anything → false");
	assert.equal(decide("turns", 11, 12, false), false, "turns/12/11 → false");
	assert.equal(decide("turns", 12, 12, false), true, "turns/12/12 → true");
	assert.equal(decide("idle", 0, 12, false), false, "idle/any/0 → false");
	assert.equal(decide("idle", 0, 2, false), false, "idle/any/0 → false");
	assert.equal(decide("idle", 1, 0, false), true, "idle/any/1 → true");
	assert.equal(decide("idle", 1, 12, false), true, "idle/any/1 → true");
	assert.equal(decide("idle", 12, 12, true), false, "inFlight short-circuits");
	assert.equal(decide("turns", 12, 12, true), false, "inFlight short-circuits");
});

test("applyDreamProposal updates the existing file in place on an exact topic match", () => {
	const entriesDir = path.join(home, "memory", "entries");
	rmSync(entriesDir, { recursive: true, force: true });
	const seed = memory.applyDreamProposal({
		entries: [{ topic: "X", body: "alpha body", tags: [], project: "global" }],
		deletes: [],
		profiles: [],
	});
	assert.equal(seed.entries, 1);
	const seeded = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
	assert.equal(seeded.length, 1, "seed entry written");

	const counts = memory.applyDreamProposal({
		entries: [{ topic: "X", body: "beta body", tags: [], project: "global" }],
		deletes: [],
		profiles: [],
	});

	assert.equal(counts.entries, 1, "updated entry still counted as applied");
	const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
	assert.deepEqual(files, seeded, "existing file updated — no second file");
	const updated = readFileSync(path.join(entriesDir, files[0] ?? ""), "utf8");
	assert.ok(updated.includes("beta body"), "body B present");
	assert.ok(!updated.includes("alpha body"), "body A replaced");
});

test("applyDreamProposal updates a high-overlap near-duplicate in place (score >= 8)", () => {
	const entriesDir = path.join(home, "memory", "entries");
	// seed tags make the cased variant deterministically clear the score-8 threshold (bare word overlap alone scores 4)
	rmSync(entriesDir, { recursive: true, force: true });
	memory.applyDreamProposal({
		entries: [
			{
				topic: "Container build gotchas",
				body: "alpha body",
				tags: ["container", "build", "gotchas"],
				project: "global",
			},
		],
		deletes: [],
		profiles: [],
	});
	const seeded = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
	assert.equal(seeded.length, 1, "seed entry written");

	const counts = memory.applyDreamProposal({
		entries: [
			{
				topic: "container build gotchas and lessons",
				body: "beta body",
				tags: [],
				project: "global",
			},
		],
		deletes: [],
		profiles: [],
	});

	assert.equal(counts.entries, 1);
	const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
	assert.deepEqual(files, seeded, "seeded file updated — no second file");
	const updated = readFileSync(path.join(entriesDir, files[0] ?? ""), "utf8");
	assert.ok(updated.includes("beta body"), "body B present");
	assert.ok(
		updated.includes("topic: container build gotchas and lessons"),
		"topic frontmatter carries the proposal's topic",
	);
});

test("applyDreamProposal writes a new file when no near-duplicate exists", () => {
	const entriesDir = path.join(home, "memory", "entries");
	rmSync(entriesDir, { recursive: true, force: true });
	memory.applyDreamProposal({
		entries: [{ topic: "X", body: "alpha body", tags: [], project: "global" }],
		deletes: [],
		profiles: [],
	});

	const counts = memory.applyDreamProposal({
		entries: [{ topic: "Z", body: "beta body", tags: [], project: "global" }],
		deletes: [],
		profiles: [],
	});

	assert.equal(counts.entries, 1);
	const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
	assert.equal(files.length, 2, "unrelated topic gets its own file");
});
