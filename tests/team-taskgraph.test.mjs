import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Task dependencies: the shared tasklist gains dependsOn — a task with an
// unmet existing dependency cannot be claimed (in_progress) until its
// prerequisites complete. Fixtures go through the production writers and the
// real tool execute calls; isolation mirrors team-durability.test.mjs.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-taskgraph-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const runtime = await import("../extensions/team-runtime.ts");
const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");

registry.setCustomSender(() => {});

// Fake member spawner — no engine child ever runs. Objectives are captured
// because the objective argument IS the member-visible protocol text
// (rolePromptFor embeds it verbatim as the member's TEAM OBJECTIVE).
const spawnedObjectives = [];
team.setMemberSpawnerForTesting((teamId, spec, objective, onState) => {
	spawnedObjectives.push({ teamId, name: spec.name, objective });
	return {
		stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
		forceKill: () => {},
		mailboxDir: path.join(HOME, ".torus", "teams", teamId, "mailboxes", spec.name),
		exited: Promise.resolve(0),
	};
});

const TEAM_TASK_CLI = fileURLToPath(new URL("../runtime/bin/team-task.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Run the member CLI as a real child process — same env, so the child's
// team-runtime resolves the same TEAMS_ROOT as the in-process one.
function teamTask(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [TEAM_TASK_CLI, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function firstJsonLine(stdout) {
	return JSON.parse(stdout.trim().split("\n")[0]);
}

function tools() {
	const registered = [];
	team.registerTeam({ registerTool: (tool) => registered.push(tool) });
	return registered;
}

function tool(registered, name) {
	const found = registered.find((t) => t.name === name);
	assert.ok(found, `${name} tool must be registered`);
	return found;
}

async function newTeam(registered, slug) {
	const created = await tool(registered, "team_create").execute(
		"call",
		{ name: slug, objective: `${slug} objective`, members: [{ name: "solo", agent: "builder" }] },
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => `sess-${slug}` } },
	);
	assert.ok(created.details.teamId, "team_create must return a teamId");
	return created.details.teamId;
}

async function createTask(registered, teamId, subject, dependsOn) {
	return tool(registered, "team_task_create").execute("call", {
		team: teamId,
		subject,
		...(dependsOn ? { dependsOn } : {}),
	});
}

after(() => {
	team.setMemberSpawnerForTesting(null);
	team.flushTeamWakesForTesting();
	registry.setCustomSender(() => {});
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

test("blockedTasks: unknown and self dependencies never block; completion clears blockers", () => {
	const tasks = [
		{ id: "t1", subject: "a", assignee: null, status: "pending", updatedAt: "x" },
		{
			id: "t2",
			subject: "b",
			assignee: null,
			status: "pending",
			updatedAt: "x",
			dependsOn: ["t9"],
		},
		{
			id: "t3",
			subject: "c",
			assignee: null,
			status: "pending",
			updatedAt: "x",
			dependsOn: ["t3"],
		},
		{
			id: "t4",
			subject: "d",
			assignee: null,
			status: "pending",
			updatedAt: "x",
			dependsOn: ["t1", "t9"],
		},
		{
			id: "t5",
			subject: "e",
			assignee: null,
			status: "completed",
			updatedAt: "x",
			dependsOn: ["t1"],
		},
	];
	let blocked = runtime.blockedTasks(tasks);
	assert.deepEqual(
		[...blocked.keys()],
		["t4", "t5"],
		"unknown dep t9 and self-dep t3 must not block",
	);
	assert.deepEqual(blocked.get("t4"), ["t1"], "only the existing uncompleted dep blocks");
	assert.deepEqual(
		blocked.get("t5"),
		["t1"],
		"only the dependency's completion matters — not the task's own status (a reopened prerequisite re-gates dependents)",
	);
	tasks[0].status = "completed";
	blocked = runtime.blockedTasks(tasks);
	assert.equal(blocked.size, 0, "completing the dependency unblocks the dependent");
});

test("claims are gated on dependencies: refused naming blockers until they complete", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "chain");
	await createTask(registered, teamId, "foundation");
	await createTask(registered, teamId, "walls", ["t1"]);
	await createTask(registered, teamId, "roof", ["t2"]);

	const early = await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t2",
		status: "in_progress",
	});
	assert.equal(early.isError, true, "claiming a blocked task must be an error");
	assert.match(early.content[0].text, /blocked by t1/);

	await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t1",
		status: "completed",
	});
	const claim = await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t2",
		status: "in_progress",
	});
	assert.ok(!claim.isError, "completing the dependency must unblock the claim");
	assert.equal(claim.content[0].text, "task t2 -> in_progress");
	assert.equal(runtime.readTasksFile(teamId).tasks[1].status, "in_progress");

	const still = await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t3",
		status: "in_progress",
	});
	assert.equal(still.isError, true, "the next link stays gated");
	assert.match(still.content[0].text, /blocked by t2/);
});

test("create rejects self-references, cycles, and unknown dependency ids", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "guards");
	await createTask(registered, teamId, "one");
	await createTask(registered, teamId, "two");
	await createTask(registered, teamId, "three");

	const self = await createTask(registered, teamId, "ouroboros", ["t4"]);
	assert.equal(self.isError, true, "a task cannot depend on itself");
	assert.match(self.content[0].text, /t4 cannot depend on itself/);

	const unknown = await createTask(registered, teamId, "ghost", ["t9"]);
	assert.equal(unknown.isError, true, "unknown dependency ids are rejected at create");
	assert.match(unknown.content[0].text, /unknown task id\(s\) in dependsOn: t9/);

	// Close a loop: a raw member edit planted t2 pointing at the id the next
	// create will take (t4) — creating t4 with a dep on t2 must refuse to
	// complete the cycle, naming the chain.
	runtime.writeTasksFile(teamId, {
		nextId: 4,
		tasks: runtime
			.readTasksFile(teamId)
			.tasks.map((t) => (t.id === "t2" ? { ...t, dependsOn: ["t4"] } : t)),
	});
	const cycle = await createTask(registered, teamId, "closer", ["t2"]);
	assert.equal(cycle.isError, true, "a create that closes a dependency cycle must be refused");
	assert.match(cycle.content[0].text, /dependency cycle: t2 -> t4 -> t2/);

	const file = runtime.readTasksFile(teamId);
	assert.equal(file.tasks.length, 3, "no refusal may leave a task behind");
	assert.equal(file.nextId, 4, "no refusal may burn an id");
});

test("list and status render blocked tasks; the lines clear as dependencies complete", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "render");
	await createTask(registered, teamId, "foundation");
	await createTask(registered, teamId, "walls", ["t1"]);
	await createTask(registered, teamId, "roof", ["t1", "t2"]);

	const list = await tool(registered, "team_task_list").execute("call", { team: teamId });
	assert.match(list.content[0].text, /- t1 \[pending\] foundation/);
	assert.match(list.content[0].text, /- t2 \[pending\] \[blocked by t1\] walls/);
	assert.match(list.content[0].text, /- t3 \[pending\] \[blocked by t1,t2\] roof/);

	const status = await tool(registered, "team_status").execute("call", { team: teamId });
	assert.match(status.content[0].text, /^blocked: t2 \(walls\) waiting on t1$/m);
	assert.match(status.content[0].text, /^blocked: t3 \(roof\) waiting on t1,t2$/m);

	await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t1",
		status: "completed",
	});
	const afterFirst = await tool(registered, "team_task_list").execute("call", { team: teamId });
	assert.match(afterFirst.content[0].text, /- t2 \[pending\] walls/);
	assert.match(afterFirst.content[0].text, /- t3 \[pending\] \[blocked by t2\] roof/);
	const statusAfterFirst = await tool(registered, "team_status").execute("call", { team: teamId });
	assert.equal(
		(statusAfterFirst.content[0].text.match(/blocked:/g) ?? []).length,
		1,
		"only t3 remains blocked after t1 completes",
	);

	await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t2",
		status: "completed",
	});
	const afterBoth = await tool(registered, "team_task_list").execute("call", { team: teamId });
	assert.ok(!afterBoth.content[0].text.includes("blocked"), "fully unblocked list shows no tag");
	const statusAfterBoth = await tool(registered, "team_status").execute("call", { team: teamId });
	assert.ok(
		!statusAfterBoth.content[0].text.includes("blocked:"),
		"fully unblocked status shows no line",
	);
});

test("CLI claim contention: two simultaneous claims on one task — exactly one wins", async () => {
	const teamId = `cli-contend-${Date.now().toString(36)}`;
	runtime.writeTasksFile(teamId, {
		nextId: 2,
		tasks: [{ id: "t1", subject: "sole", assignee: null, status: "pending", updatedAt: "x" }],
	});
	const [a, b] = await Promise.all([
		teamTask(["claim", teamId, "--as", "m1"]),
		teamTask(["claim", teamId, "--as", "m2"]),
	]);
	assert.deepEqual(
		[a.code, b.code].sort(),
		[0, 1],
		"exactly one claim must succeed (exit 0) and the other must refuse (exit 1)",
	);
	const winner = a.code === 0 ? a : b;
	const loser = a.code === 0 ? b : a;
	const claimed = firstJsonLine(winner.stdout);
	assert.equal(claimed.ok, true);
	assert.equal(claimed.task.id, "t1");
	assert.equal(claimed.task.status, "in_progress");
	const refused = firstJsonLine(loser.stdout);
	assert.equal(refused.ok, false);
	assert.match(refused.error, /no claimable task/);
	const onDisk = runtime.readTasksFile(teamId);
	assert.equal(onDisk.tasks.length, 1, "tasks.json stays consistent — no duplicates");
	assert.equal(onDisk.tasks[0].assignee, claimed.task.assignee);
	assert.equal(onDisk.tasks[0].status, "in_progress");
});

test("CLI claim skips assigned and blocked tasks, taking the first claimable by id order", async () => {
	const teamId = `cli-skip-${Date.now().toString(36)}`;
	runtime.writeTasksFile(teamId, {
		nextId: 4,
		tasks: [
			{ id: "t1", subject: "taken", assignee: "other", status: "in_progress", updatedAt: "x" },
			{
				id: "t2",
				subject: "gated",
				assignee: null,
				status: "pending",
				updatedAt: "x",
				dependsOn: ["t1"],
			},
			{ id: "t3", subject: "free", assignee: null, status: "pending", updatedAt: "x" },
		],
	});
	const claim = await teamTask(["claim", teamId, "--as", "me"]);
	assert.equal(claim.code, 0);
	const claimed = firstJsonLine(claim.stdout);
	assert.equal(claimed.task.id, "t3", "t1 is assigned, t2 is blocked — t3 is the first claimable");
	const onDisk = runtime.readTasksFile(teamId);
	assert.equal(onDisk.tasks.find((t) => t.id === "t1").assignee, "other");
	assert.equal(onDisk.tasks.find((t) => t.id === "t1").status, "in_progress", "t1 untouched");
	assert.equal(onDisk.tasks.find((t) => t.id === "t2").status, "pending", "t2 untouched");
	// The board is now fully assigned/blocked: a further claim refuses.
	const none = await teamTask(["claim", teamId, "--as", "late"]);
	assert.equal(none.code, 1);
	assert.match(firstJsonLine(none.stdout).error, /no claimable task/);
});

test("CLI complete and release verify the assignee; mismatches refuse", async () => {
	const teamId = `cli-assignee-${Date.now().toString(36)}`;
	runtime.writeTasksFile(teamId, {
		nextId: 3,
		tasks: [
			{ id: "t1", subject: "one", assignee: null, status: "pending", updatedAt: "x" },
			{ id: "t2", subject: "two", assignee: null, status: "pending", updatedAt: "x" },
		],
	});
	assert.equal((await teamTask(["claim", teamId, "--as", "alice"])).code, 0);

	const wrongComplete = await teamTask(["complete", teamId, "t1", "--as", "bob"]);
	assert.equal(wrongComplete.code, 1);
	assert.match(firstJsonLine(wrongComplete.stdout).error, /assigned to alice, not bob/);

	const complete = await teamTask(["complete", teamId, "t1", "--as", "alice"]);
	assert.equal(complete.code, 0);
	assert.equal(firstJsonLine(complete.stdout).task.status, "completed");

	const wrongRelease = await teamTask(["release", teamId, "t1", "--as", "bob"]);
	assert.equal(wrongRelease.code, 1);
	assert.match(firstJsonLine(wrongRelease.stdout).error, /assigned to alice, not bob/);

	const release = await teamTask(["release", teamId, "t1", "--as", "alice"]);
	assert.equal(release.code, 0);
	const released = firstJsonLine(release.stdout).task;
	assert.equal(released.status, "pending");
	assert.equal(released.assignee, null);

	const unknown = await teamTask(["complete", teamId, "t9", "--as", "alice"]);
	assert.equal(unknown.code, 1);
	assert.match(firstJsonLine(unknown.stdout).error, /no task t9/);
});

test("selfClaim threads the claim protocol sentence into the member-visible objective (default off)", async () => {
	const registered = tools();
	spawnedObjectives.length = 0;
	const off = await newTeam(registered, "scoff");
	const offObjectives = spawnedObjectives.filter((o) => o.teamId === off).map((o) => o.objective);
	assert.ok(offObjectives.length > 0, "the spawner must receive the member objective");
	for (const objective of offObjectives) {
		assert.equal(
			objective,
			"scoff objective",
			"default teams: objective unchanged, nothing appended",
		);
		assert.ok(!objective.includes("team-task.mjs"), "no claim sentence when selfClaim is off");
	}
	assert.equal(runtime.readTeamSpec(off).selfClaim, undefined, "spec round-trips absence");

	spawnedObjectives.length = 0;
	const on = await tool(registered, "team_create").execute(
		"call",
		{
			name: "scon",
			objective: "scon objective",
			members: [{ name: "solo", agent: "builder" }],
			selfClaim: true,
		},
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => "sess-scon" } },
	);
	assert.ok(on.details.teamId);
	const onObjectives = spawnedObjectives
		.filter((o) => o.teamId === on.details.teamId)
		.map((o) => o.objective);
	assert.ok(onObjectives.length > 0);
	const sentence = `Claim work atomically with \`node runtime/bin/team-task.mjs claim ${on.details.teamId} --as <your-name>\`; only pending unassigned unblocked tasks are claimable; release with the release subcommand if you cannot finish.`;
	for (const objective of onObjectives) {
		assert.equal(
			objective,
			`scon objective ${sentence}`,
			"opted-in teams: exactly one sentence appended",
		);
	}
	assert.equal(
		runtime.readTeamSpec(on.details.teamId).selfClaim,
		true,
		"spec round-trips the flag",
	);
});
