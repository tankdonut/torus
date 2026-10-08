import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The tasklist is member-writable by hand; a member writing a plausible
// non-canonical status ("done") must not silently deadlock dependents.
// Reads and writes canonicalize statuses; exact-match consumers
// (blockedTasks, claim scan, stale scan) only ever see the canonical set.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-task-status-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const runtime = await import("../extensions/team-runtime.ts");

const TEAM = "status-team";

function seedTeam() {
	const dir = runtime.teamDir(TEAM);
	mkdirSync(path.join(dir, "mailboxes", "alpha"), { recursive: true });
	return dir;
}

function seedRawTasks(statuses) {
	const dir = seedTeam();
	writeFileSync(
		path.join(dir, "tasks.json"),
		JSON.stringify({
			tasks: Object.entries(statuses).map(([id, status], i) => ({
				id,
				subject: `task ${id}`,
				assignee: i === 0 ? "alpha" : null,
				status,
				updatedAt: new Date().toISOString(),
				...(id === "t2" ? { dependsOn: ["t1"] } : {}),
			})),
			nextId: 3,
		}),
	);
}

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("hand-written 'done' reads as completed and unblocks dependents", () => {
	seedRawTasks({ t1: "done", t2: "pending" });
	const file = runtime.readTasksFile(TEAM);
	assert.equal(file.tasks[0].status, "completed");
	const blocked = runtime.blockedTasks(file.tasks);
	assert.equal(blocked.has("t2"), false, "dependent must not stay blocked by 'done'");
});

test("unknown status reads as pending, never a hidden lock", () => {
	seedRawTasks({ t1: "bananas", t2: "pending" });
	const file = runtime.readTasksFile(TEAM);
	assert.equal(file.tasks[0].status, "pending");
	assert.equal(
		runtime.blockedTasks(file.tasks).has("t2"),
		true,
		"unknown is re-work, still blocking",
	);
});

test("canonical statuses pass through unchanged", () => {
	seedRawTasks({ t1: "completed", t2: "in_progress" });
	seedRawTasks({ t1: "pending", t2: "deleted" });
	const file = runtime.readTasksFile(TEAM);
	assert.deepEqual(
		file.tasks.map((t) => t.status),
		["pending", "deleted"],
	);
});

test("cased and spaced synonyms fold", () => {
	seedRawTasks({ t1: "COMPLETE", t2: "  In Progress " });
	const file = runtime.readTasksFile(TEAM);
	assert.equal(file.tasks[0].status, "completed");
	assert.equal(file.tasks[1].status, "in_progress");
	assert.equal(runtime.blockedTasks(file.tasks).has("t2"), false);
});

test("non-string status reads as pending", () => {
	seedRawTasks({ t1: true, t2: "pending" });
	const file = runtime.readTasksFile(TEAM);
	assert.equal(file.tasks[0].status, "pending");
});

test("writeTasksFile normalizes before persisting", () => {
	seedTeam();
	runtime.writeTasksFile(TEAM, {
		tasks: [
			{
				id: "t1",
				subject: "task t1",
				assignee: "alpha",
				status: "finished",
				updatedAt: new Date().toISOString(),
			},
		],
		nextId: 2,
	});
	assert.equal(runtime.readTasksFile(TEAM).tasks[0].status, "completed");
});
