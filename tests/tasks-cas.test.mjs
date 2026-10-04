import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";

const { readTasksFile, updateTasksFile, writeTasksFile, teamDir } = await import(
	"../extensions/team-runtime.ts"
);

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
