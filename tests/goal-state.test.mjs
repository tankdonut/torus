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

const goalState = (text) => ({ goal: text, status: "active", createdAt: 1, notes: [] });

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
		assert.equal(goal.readGoal("sess-a").goal, "ship it");
		assert.equal(goal.readGoal("sess-a").goal, "ship it");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("cleared goal writes a literal null that reads back null", () => {
	try {
		goal.writeGoal("sess-d", null);
		assert.equal(existsSync(newGoalFile("sess-d")), true, "clear still writes the file");
		assert.equal(
			JSON.parse(readFileSync(newGoalFile("sess-d"), "utf8")),
			null,
			"literal null content",
		);
		assert.equal(goal.readGoal("sess-d"), null);

		writeFileSync(newGoalFile("sess-d2"), "null", "utf8");
		assert.equal(goal.readGoal("sess-d2"), null, "present-but-null wins");
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
