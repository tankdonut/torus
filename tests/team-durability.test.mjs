import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Team durability: a parent killed between writes leaves on-disk state as the
// only witness. Fixtures are planted with the production spec/tasklist writers
// BEFORE the team module is imported; the first registerTeam() below then
// rehydrates them cold. Each test file runs as its own process under
// `node --test`, so the env-first imports here are a genuine first import:
// registry derives its dirs from TORUS_HOME, team-runtime derives TEAMS_ROOT
// from HOME (same isolation contract as team-transcript.test.mjs).
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-durability-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const runtime = await import("../extensions/team-runtime.ts");
const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");

registry.setCustomSender(() => {});

// Fake member spawner (team-idle-notify pattern) — no engine child ever runs.
const spawned = [];
team.setMemberSpawnerForTesting((teamId, spec, _objective, onState) => {
	spawned.push({ teamId, spec, onState });
	return {
		stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
		forceKill: () => {},
		mailboxDir: path.join(HOME, ".torus", "teams", teamId, "mailboxes", spec.name),
		exited: Promise.resolve(0),
	};
});

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

async function statusText(registered, teamId) {
	const result = await tool(registered, "team_status").execute("call", { team: teamId });
	return result.content[0].text;
}

const STAMP = "2026-10-07T00:00:00.000Z";

/** Plant exactly what a killed parent leaves behind: spec + tasklist on disk, nothing else. */
function plantTeam(teamId, { name, status, member, tasks }) {
	runtime.writeTeamSpec(teamId, {
		name,
		objective: `${name} standing objective`,
		members: [{ name: member, agent: "builder" }],
		status,
		parentSession: `sess-${teamId}`,
	});
	runtime.writeTasksFile(teamId, { tasks, nextId: tasks.length + 1 });
}

after(() => {
	team.setMemberSpawnerForTesting(null);
	team.flushTeamWakesForTesting();
	registry.setCustomSender(() => {});
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

test("cold rehydrate: disk-only team comes back listed, rendered, and with tasks intact", async () => {
	plantTeam("team-alpha", {
		name: "alpha",
		status: "active",
		member: "solo",
		tasks: [
			{
				id: "t1",
				subject: "harden the gate",
				assignee: "solo",
				status: "in_progress",
				updatedAt: STAMP,
			},
			{
				id: "t2",
				subject: "triage the backlog",
				assignee: null,
				status: "pending",
				updatedAt: STAMP,
			},
		],
	});

	// first registerTeam in this process — rehydrateAllTeams runs here
	const registered = tools();

	assert.ok(registry.getTeam("team-alpha"), "rehydrated team must be in the registry");
	assert.ok(
		registry.listTeams().some((t) => t.id === "team-alpha"),
		"rehydrated team must be listed",
	);

	const text = await statusText(registered, "team-alpha");
	assert.match(text, /^team alpha \[active\] — alpha standing objective$/m);
	assert.match(text, /^- solo \(builder\) · stopped — /m);

	const list = await tool(registered, "team_task_list").execute("call", { team: "team-alpha" });
	assert.match(list.content[0].text, /- t1 \[in_progress\] @solo harden the gate/);
	assert.match(list.content[0].text, /- t2 \[pending\] triage the backlog/);

	assert.deepEqual(
		runtime.readTasksFile("team-alpha").tasks.map((t) => `${t.id}:${t.status}:${t.assignee}`),
		["t1:in_progress:solo", "t2:pending:null"],
		"rehydration must leave the tasklist untouched",
	);
});

test("kill-before-shutdown: spec left active rehydrates as a live record; only a shutdown spec does not", () => {
	// The parent died before markTeamStatus("shutdown") could run: team.json
	// still says active and no shutdown marker exists. The on-disk word is the
	// whole truth — this is the durability claim, pinned.
	plantTeam("team-bravo", { name: "bravo", status: "active", member: "lone", tasks: [] });
	tools();

	const record = registry.getTeam("team-bravo");
	assert.ok(record, "an abruptly-killed parent's team must rehydrate");
	assert.equal(
		record.status,
		"active",
		"an active spec must come back as a live record, not shutdown",
	);
	assert.equal(record.members[0].status, "stopped", "rehydrated members start stopped");
	assert.equal(
		runtime.readTeamSpec("team-bravo")?.status,
		"active",
		"rehydration is read-only — the spec must not be rewritten",
	);

	// Contrast pins the mapping: a spec that did get its shutdown marker
	// rehydrates as shutdown — the status field is honored, not ignored.
	plantTeam("team-hotel", { name: "hotel", status: "shutdown", member: "ghost", tasks: [] });
	tools();
	assert.equal(registry.getTeam("team-hotel")?.status, "shutdown");
});

test("orphan surfacing: in_progress task under a stopped member is named in team_status", async () => {
	plantTeam("team-charlie", {
		name: "charlie",
		status: "active",
		member: "delta",
		tasks: [
			{
				id: "t1",
				subject: "chase the flaky gate",
				assignee: "delta",
				status: "in_progress",
				updatedAt: STAMP,
			},
			{
				id: "t2",
				subject: "parked follow-up",
				assignee: "delta",
				status: "pending",
				updatedAt: STAMP,
			},
		],
	});
	const registered = tools();
	const text = await statusText(registered, "team-charlie");
	assert.match(
		text,
		/^orphaned: t1 \(chase the flaky gate\) was in-progress under @delta \(stopped\) — reassign or complete via team_task_update$/m,
	);
	assert.equal(
		(text.match(/orphaned:/g) ?? []).length,
		1,
		"a pending task under a stopped member is not an orphan",
	);
});

test("orphan surfacing: same task under a working member stays silent; stopping the member surfaces it", async () => {
	const registered = tools();
	const created = await tool(registered, "team_create").execute(
		"call",
		{ name: "echo", objective: "test objective", members: [{ name: "foxtrot", agent: "builder" }] },
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => "sess-echo" } },
	);
	const teamId = created.details.teamId;
	assert.ok(teamId, "team_create must return a teamId");

	spawned.at(-1).onState({ status: "working", sessionId: "sess-foxtrot" });
	await tool(registered, "team_task_create").execute("call", {
		team: teamId,
		subject: "close the loop",
		assignee: "foxtrot",
	});
	await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t1",
		status: "in_progress",
	});

	let text = await statusText(registered, teamId);
	assert.equal(
		(text.match(/orphaned:/g) ?? []).length,
		0,
		"an in_progress task under a working member is not an orphan",
	);

	spawned.at(-1).onState({ status: "stopped", sessionId: "sess-foxtrot" });
	text = await statusText(registered, teamId);
	assert.match(
		text,
		/^orphaned: t1 \(close the loop\) was in-progress under @foxtrot \(stopped\) — reassign or complete via team_task_update$/m,
	);
});
