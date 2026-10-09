import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-goal-state-"));
process.env["TORUS_HOME"] = home;

const goal = await import("../extensions/goal/index.ts");
const fsutil = await import("../extensions/fsutil.ts");
const sessions = await import("../extensions/sessions/index.ts");

const ORPHAN = "11111111-1111-7111-8111-111111111111";
const LIVE = "22222222-2222-7222-8222-222222222222";

const newGoalFile = (id) => path.join(fsutil.projectStateDir(), "goal", `${id}.json`);
const legacyGoalFile = (id) => path.join(home, "goal", `${id}.json`);

const goalState = (text) => ({ goal: text, status: "active", createdAt: 1, notes: [] });

function plantLegacy(id, state) {
	mkdirSync(path.join(home, "goal"), { recursive: true });
	writeFileSync(legacyGoalFile(id), JSON.stringify(state, null, 2), "utf8");
}

function ageFile(file, days) {
	const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	utimesSync(file, when, when);
}

function plantedSessionsRoot() {
	const root = mkdtempSync(path.join(tmpdir(), "torus-goal-sessions-"));
	const proj = path.join(root, "--planted-project--");
	mkdirSync(proj);
	writeFileSync(path.join(proj, `2026-10-09T00-00-00-000Z_${LIVE}.jsonl`), "{}", "utf8");
	return root;
}

test("writeGoal lands under TORUS_HOME/state/<project-key>/goal", () => {
	try {
		goal.writeGoal("sess-a", goalState("ship it"));
		const file = newGoalFile("sess-a");
		assert.equal(existsSync(file), true, "project-scoped file written");
		assert.equal(
			existsSync(path.join(home, "goal", "sess-a.json")),
			false,
			"nothing planted in legacy dir",
		);
		assert.equal(goal.readGoal("sess-a").goal, "ship it");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("legacy goal still reads when the project-scoped file is absent", () => {
	try {
		plantLegacy("sess-b", { goal: "legacy goal", status: "paused", createdAt: 2, notes: ["n1"] });
		const state = goal.readGoal("sess-b");
		assert.equal(state?.goal, "legacy goal");
		assert.equal(state?.notes[0], "n1");
		assert.equal(existsSync(newGoalFile("sess-b")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("writeGoal migrates: new file written, legacy twin unlinked", () => {
	try {
		plantLegacy("sess-c", goalState("old"));
		goal.writeGoal("sess-c", goalState("new"));
		assert.equal(existsSync(newGoalFile("sess-c")), true, "new file written");
		assert.equal(
			existsSync(legacyGoalFile("sess-c")),
			false,
			"legacy twin removed after the write",
		);
		assert.equal(goal.readGoal("sess-c").goal, "new");
		assert.equal(JSON.parse(readFileSync(newGoalFile("sess-c"), "utf8")).goal, "new");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("cleared goal (present-null) does not resurrect from a stale legacy twin", () => {
	try {
		plantLegacy("sess-d", goalState("stale"));
		goal.writeGoal("sess-d", null);
		assert.equal(existsSync(newGoalFile("sess-d")), true, "clear still writes the new file");
		assert.equal(
			JSON.parse(readFileSync(newGoalFile("sess-d"), "utf8")),
			null,
			"literal null content",
		);
		assert.equal(goal.readGoal("sess-d"), null);

		writeFileSync(newGoalFile("sess-d2"), "null", "utf8");
		plantLegacy("sess-d2", goalState("stale twin"));
		assert.equal(goal.readGoal("sess-d2"), null, "present-but-null wins over legacy");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("fresh goal file is kept even when its session is gone (age floor)", () => {
	try {
		goal.writeGoal(ORPHAN, goalState("fresh orphan"));
		const file = newGoalFile(ORPHAN);
		assert.equal(
			goal.pruneGoalOrphans(() => false),
			0,
		);
		assert.equal(existsSync(file), true, "fresh file kept");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aged orphan goal file is pruned when its session no longer exists", () => {
	try {
		goal.writeGoal(ORPHAN, goalState("aged orphan"));
		const file = newGoalFile(ORPHAN);
		ageFile(file, 40);
		const root = plantedSessionsRoot();
		try {
			assert.equal(
				goal.pruneGoalOrphans((id) => sessions.sessionFileExists(id, root)),
				1,
			);
			assert.equal(existsSync(file), false, "aged orphan pruned");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aged goal file for a live session is kept", () => {
	try {
		goal.writeGoal(LIVE, goalState("aged live"));
		const file = newGoalFile(LIVE);
		ageFile(file, 40);
		const root = plantedSessionsRoot();
		try {
			assert.equal(
				goal.pruneGoalOrphans((id) => sessions.sessionFileExists(id, root)),
				0,
			);
			assert.equal(existsSync(file), true, "live session's file kept");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unreadable sessions root keeps all goal files", () => {
	try {
		goal.writeGoal(LIVE, goalState("aged live"));
		goal.writeGoal(ORPHAN, goalState("aged orphan"));
		ageFile(newGoalFile(LIVE), 40);
		ageFile(newGoalFile(ORPHAN), 40);
		const missingRoot = path.join(home, "no-such-sessions-root");
		assert.equal(
			goal.pruneGoalOrphans((id) => sessions.sessionFileExists(id, missingRoot)),
			0,
		);
		assert.equal(existsSync(newGoalFile(LIVE)), true);
		assert.equal(existsSync(newGoalFile(ORPHAN)), true, "null (unreadable) prunes nothing");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("orphan GC never deletes files under the legacy goal dir", () => {
	try {
		plantLegacy(ORPHAN, goalState("legacy orphan"));
		ageFile(legacyGoalFile(ORPHAN), 40);
		goal.pruneGoalOrphans(() => false);
		assert.equal(existsSync(legacyGoalFile(ORPHAN)), true, "legacy dir untouched by GC");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
