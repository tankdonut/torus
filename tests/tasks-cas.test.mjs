import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";

const { readTasksFile, updateTasksFile, writeTasksFile, teamDir } = await import(
	"../extensions/team-runtime.ts"
);

test("dependsOn-carrying mutations survive the CAS rebase (mutator idempotency with the new field)", () => {
	const teamId = `test-${randomUUID().slice(0, 8)}`;
	writeTasksFile(teamId, {
		nextId: 3,
		tasks: [
			{ id: "t1", subject: "base", assignee: null, status: "pending", updatedAt: "x" },
			{ id: "t2", subject: "dep target", assignee: null, status: "pending", updatedAt: "x" },
		],
	});
	try {
		let sabotaged = false;
		const result = updateTasksFile(teamId, (file) => {
			if (!sabotaged) {
				sabotaged = true;
				const raw = readTasksFile(teamId);
				writeTasksFile(teamId, {
					nextId: 100,
					tasks: [
						...raw.tasks,
						{
							id: "t99",
							subject: "member bash edit",
							assignee: null,
							status: "pending",
							updatedAt: "m",
							dependsOn: ["t1"],
						},
					],
				});
			}
			// Re-runnable assigns: every attempt writes the same values, so a CAS
			// retry against the fresh read converges instead of duplicating.
			const t1 = file.tasks.find((t) => t.id === "t1");
			t1.dependsOn = ["t2"];
			const t2 = file.tasks.find((t) => t.id === "t2");
			t2.status = "completed";
		});
		const pick = (tasks, id) => tasks.find((t) => t.id === id);
		assert.deepEqual(
			pick(result.tasks, "t1")?.dependsOn,
			["t2"],
			"the lead's dependsOn edit must land",
		);
		const onDisk = readTasksFile(teamId);
		assert.deepEqual(
			pick(onDisk.tasks, "t1")?.dependsOn,
			["t2"],
			"dependsOn must survive the CAS rebase on disk",
		);
		assert.equal(pick(onDisk.tasks, "t2")?.status, "completed");
		assert.deepEqual(
			pick(onDisk.tasks, "t99")?.dependsOn,
			["t1"],
			"the member's dependsOn write must survive the RMW",
		);
		assert.equal(onDisk.tasks.filter((t) => t.subject === "member bash edit").length, 1);
	} finally {
		rmSync(teamDir(teamId), { recursive: true, force: true });
	}
});

test("raw member write during the RMW window is rebased, not lost (mtime CAS)", () => {
	const teamId = `test-${randomUUID().slice(0, 8)}`;
	writeTasksFile(teamId, {
		nextId: 2,
		tasks: [{ id: "t1", subject: "base", assignee: null, status: "pending", updatedAt: "x" }],
	});
	try {
		let sabotaged = false;
		const result = updateTasksFile(teamId, (file) => {
			if (!sabotaged) {
				sabotaged = true;
				const raw = readTasksFile(teamId);
				writeTasksFile(teamId, {
					nextId: 100,
					tasks: [
						...raw.tasks,
						{
							id: "t99",
							subject: "member bash edit",
							assignee: null,
							status: "pending",
							updatedAt: "m",
						},
					],
				});
			}
			file.tasks = [
				...file.tasks,
				{ id: "t50", subject: "lead edit", assignee: null, status: "pending", updatedAt: "l" },
			];
		});
		const subjects = result.tasks.map((t) => t.subject);
		assert.ok(subjects.includes("member bash edit"), "member raw write must survive the RMW");
		assert.ok(subjects.includes("lead edit"), "lead mutation must land");
		assert.equal(
			result.tasks.filter((t) => t.subject === "lead edit").length,
			1,
			"retry must not duplicate the lead edit",
		);
		const onDisk = readTasksFile(teamId);
		assert.ok(
			onDisk.tasks.some((t) => t.subject === "member bash edit"),
			"disk keeps the member write",
		);
	} finally {
		rmSync(teamDir(teamId), { recursive: true, force: true });
	}
});
