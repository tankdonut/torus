import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Team durability: a parent killed between writes leaves on-disk state as the
// only witness. Fixtures are planted with the production spec/tasklist writers
// BEFORE the team module is imported; the first registerTeam() below then
// rehydrates them cold. Each test file runs as its own process under
// `node --test`, so the env-first imports here are a genuine first import:
// registry and team-runtime both derive their dirs from TORUS_HOME (same
// isolation contract as team-transcript.test.mjs).
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
		mailboxDir: path.join(HOME, "teams", teamId, "mailboxes", spec.name),
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

// Stale surfacing: an in_progress task under an IDLE member (working means
// active, stopped is the orphan case above) is flagged once its tasklist
// clock — task.updatedAt — outlives TORUS_TASK_STALE_MIN (default 30min).
// The clock is planted by rewriting tasks.json through the production writer,
// exactly what a member that claimed then went quiet leaves on disk.
async function plantStaleFixture(name, memberStatus, updatedAgoMs) {
	const registered = tools();
	const created = await tool(registered, "team_create").execute(
		"call",
		{ name, objective: "stale probe", members: [{ name: "kilo", agent: "builder" }] },
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => `sess-${name}` } },
	);
	const teamId = created.details.teamId;
	assert.ok(teamId, "team_create must return a teamId");
	spawned.at(-1).onState({ status: memberStatus, sessionId: `sess-${name}` });
	await tool(registered, "team_task_create").execute("call", {
		team: teamId,
		subject: "rescue the wedged build",
		assignee: "kilo",
	});
	await tool(registered, "team_task_update").execute("call", {
		team: teamId,
		task: "t1",
		status: "in_progress",
	});
	const file = runtime.readTasksFile(teamId);
	const task = file.tasks.find((t) => t.id === "t1");
	assert.ok(task, "fixture task must exist");
	task.updatedAt = new Date(Date.now() - updatedAgoMs).toISOString();
	runtime.writeTasksFile(teamId, file);
	return { registered, teamId };
}

/** Set one env var for the duration of fn, restoring whatever was there (unset included). */
async function withEnv(name, value, fn) {
	const saved = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

test("stale surfacing: idle member + task untouched for 31min renders the stale line with elapsed minutes", async () => {
	const { registered, teamId } = await plantStaleFixture("stale-old", "idle", 31 * 60_000);
	const text = await statusText(registered, teamId);
	assert.match(
		text,
		/^stale: t1 \(rescue the wedged build\) in-progress under @kilo for 31min — nudge via team_msg or release via team-task\/team_task_update$/m,
		"a 31min-old in_progress task under an idle member must be named stale",
	);
});

test("stale surfacing: fresh clock stays silent under the default threshold", async () => {
	const { registered, teamId } = await plantStaleFixture("stale-fresh", "idle", 5 * 60_000);
	const text = await statusText(registered, teamId);
	assert.equal(
		(text.match(/stale:/g) ?? []).length,
		0,
		"a 5min-old task under an idle member is not stale at the default 30min threshold",
	);
});

test("stale surfacing: a WORKING member is never stale — work may simply be slow", async () => {
	const { registered, teamId } = await plantStaleFixture("stale-working", "working", 31 * 60_000);
	const text = await statusText(registered, teamId);
	assert.equal(
		(text.match(/stale:/g) ?? []).length,
		0,
		"an old clock under a working member must not render a stale line",
	);
});

test("stale surfacing: a STOPPED member stays the orphan case — no double flagging", async () => {
	const { registered, teamId } = await plantStaleFixture("stale-stopped", "stopped", 31 * 60_000);
	const text = await statusText(registered, teamId);
	assert.match(
		text,
		/^orphaned: t1 \(rescue the wedged build\) was in-progress under @kilo \(stopped\) — reassign or complete via team_task_update$/m,
	);
	assert.equal(
		(text.match(/stale:/g) ?? []).length,
		0,
		"a stopped member's task is an orphan, not stale — one line per problem",
	);
});

test("stale surfacing: TORUS_TASK_STALE_MIN flips the verdict on a recent clock; garbage falls back to 30", async () => {
	const { registered, teamId } = await plantStaleFixture("stale-tuned", "idle", 5 * 60_000);
	await withEnv("TORUS_TASK_STALE_MIN", "1", async () => {
		const text = await statusText(registered, teamId);
		assert.match(
			text,
			/^stale: t1 \(rescue the wedged build\) in-progress under @kilo for 5min — nudge via team_msg or release via team-task\/team_task_update$/m,
			"threshold 1 must flag a 5min-old task",
		);
	});
	await withEnv("TORUS_TASK_STALE_MIN", "0", async () => {
		const text = await statusText(registered, teamId);
		assert.match(text, /stale: t1 /m, "threshold 0 must flag any age");
	});
	await withEnv("TORUS_TASK_STALE_MIN", "banana", async () => {
		const text = await statusText(registered, teamId);
		assert.equal(
			(text.match(/stale:/g) ?? []).length,
			0,
			"an unparseable threshold must silently fall back to 30",
		);
	});
	const text = await statusText(registered, teamId);
	assert.equal(
		(text.match(/stale:/g) ?? []).length,
		0,
		"the default must be restored after the env probes",
	);
});

// Structured-output checks: pi-ai exports Type but no Value, so validate
// structuredContent against the tool's real outputSchema (plain JSON Schema)
// with a hand-rolled checker, plus a permissiveness walk (optional fields,
// no additionalProperties bans).
function schemaError(schema, value, at = "value") {
	if (schema.anyOf) {
		return schema.anyOf.some((s) => schemaError(s, value, at) === null)
			? null
			: `${at}: matches no union member`;
	}
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return `${at}: expected object`;
		for (const key of schema.required ?? []) {
			if (!(key in value)) return `${at}.${key}: required`;
		}
		for (const [key, prop] of Object.entries(schema.properties ?? {})) {
			if (!(key in value)) continue;
			const err = schemaError(prop, value[key], `${at}.${key}`);
			if (err) return err;
		}
		return null;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return `${at}: expected array`;
		for (const [i, item] of value.entries()) {
			const err = schemaError(schema.items, item, `${at}[${i}]`);
			if (err) return err;
		}
		return null;
	}
	if (schema.type === "string") return typeof value === "string" ? null : `${at}: expected string`;
	if (schema.type === "number") return typeof value === "number" ? null : `${at}: expected number`;
	if (schema.type === "boolean")
		return typeof value === "boolean" ? null : `${at}: expected boolean`;
	if (schema.type === "null") return value === null ? null : `${at}: expected null`;
	return `${at}: unsupported schema type ${String(schema.type)}`;
}

function assertPermissive(schema, at = "schema") {
	if (schema.anyOf) {
		for (const member of schema.anyOf) assertPermissive(member, at);
		return;
	}
	if (schema.type === "array") {
		assertPermissive(schema.items, `${at}[]`);
		return;
	}
	if (schema.type !== "object" || !schema.properties) return;
	assert.notEqual(schema.additionalProperties, false, `${at} must not ban additional properties`);
	const required = new Set(schema.required ?? []);
	for (const [key, prop] of Object.entries(schema.properties)) {
		assert.ok(!required.has(key), `${at}.${key} must be optional`);
		assertPermissive(prop, `${at}.${key}`);
	}
}

function assertStructured(tool, structured) {
	assert.ok(tool.outputSchema, `${tool.name} must declare outputSchema`);
	const err = schemaError(tool.outputSchema, structured);
	assert.ok(err === null, `${tool.name} structuredContent fails outputSchema: ${err}`);
}

test("team_status structuredContent mirrors the rendered roster, stale, and blocked lines", async () => {
	const { registered, teamId } = await plantStaleFixture("scon-status", "idle", 31 * 60_000);
	await tool(registered, "team_task_create").execute("call", {
		team: teamId,
		subject: "follow the rescue",
		dependsOn: ["t1"],
	});

	const statusTool = tool(registered, "team_status");
	assertPermissive(statusTool.outputSchema);
	const result = await statusTool.execute("call", { team: teamId });
	assertStructured(statusTool, result.structuredContent);
	const sc = result.structuredContent;
	assert.equal(sc.team, teamId);
	assert.equal(sc.status, "active");
	assert.deepEqual(sc.members, [
		{ name: "kilo", agent: "builder", status: "idle", reportTail: "(no outbox yet)" },
	]);
	assert.deepEqual(sc.stale, [
		{ id: "t1", subject: "rescue the wedged build", assignee: "kilo", minutes: 31 },
	]);
	assert.deepEqual(sc.blocked, [{ id: "t2", subject: "follow the rescue", dependsOn: ["t1"] }]);
	assert.deepEqual(sc.orphaned, []);

	const text = result.content[0].text;
	assert.match(text, /stale: t1 .* for 31min/, "text still renders the stale line");
	assert.match(text, /blocked: t2 .* waiting on t1/, "text still renders the blocked line");

	const missing = await statusTool.execute("call", { team: "ghost-team" });
	assert.equal(missing.isError, true);
	assert.equal(missing.structuredContent, undefined, "no-such-team omits structuredContent");
});

// ---- project-scoped default team resolution ----
// Specs carry the project key of the creating cwd; default resolution only
// considers same-project teams (legacy specs with no key match any). Explicit
// ids are never filtered. Each scenario resets the registry and registers
// crafted records so earlier fixtures cannot compete for the default pick;
// the status tool is captured before the drop (tools() rehydrates from disk,
// and resetRegistryForTesting does not clear the shared teams map).
const CURRENT_PROJECT = `--${process.cwd().replace(/^\/+/, "").replaceAll("/", "-")}--`;
const OTHER_PROJECT = "--elsewhere--";

function craftStatusTool() {
	const statusTool = tool(tools(), "team_status");
	registry.resetRegistryForTesting();
	for (const record of registry.listTeams()) registry.dropTeam(record.id);
	return statusTool;
}

function registerCraftedTeam(teamId, { project, createdAt }) {
	runtime.writeTeamSpec(teamId, {
		name: teamId,
		objective: `${teamId} standing objective`,
		members: [{ name: "solo", agent: "builder" }],
		status: "active",
		...(project === undefined ? {} : { project }),
	});
	registry.registerTeam({
		id: teamId,
		name: teamId,
		objective: `${teamId} standing objective`,
		status: "active",
		dir: runtime.teamDir(teamId),
		members: [
			{
				id: `${teamId}/solo`,
				name: "solo",
				agent: "builder",
				model: "test-model",
				status: "idle",
				sessionId: null,
				startedAt: 0,
				mailboxDir: "",
			},
		],
		createdAt,
	});
}

test("team_create stamps the creating cwd's project key into team.json", async () => {
	const registered = tools();
	const created = await tool(registered, "team_create").execute(
		"call",
		{
			name: "projstamp",
			objective: "stamp the project",
			members: [{ name: "alpha", agent: "builder" }],
		},
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => "sess-projstamp" } },
	);
	const teamId = created.details.teamId;
	assert.ok(teamId, "team_create must return a teamId");
	assert.equal(runtime.readTeamSpec(teamId)?.project, CURRENT_PROJECT);
});

test("default resolution prefers the current project's team over a newer foreign one", async () => {
	const statusTool = craftStatusTool();
	registerCraftedTeam("scoped-foreign", { project: OTHER_PROJECT, createdAt: 9000 });
	registerCraftedTeam("scoped-local", { project: CURRENT_PROJECT, createdAt: 1000 });
	const result = await statusTool.execute("call", {});
	assert.match(result.content[0].text, /^team scoped-local \[active\]/m);
});

test("default resolution reports none when only foreign-project teams exist", async () => {
	const statusTool = craftStatusTool();
	registerCraftedTeam("scoped-only-foreign", { project: OTHER_PROJECT, createdAt: 9000 });
	const result = await statusTool.execute("call", {});
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /No such team/);

	const explicit = await statusTool.execute("call", { team: "scoped-only-foreign" });
	assert.match(explicit.content[0].text, /^team scoped-only-foreign \[active\]/m);
});

test("legacy flat specs match any project until rewritten; a status write migrates and pins them", async () => {
	const statusTool = craftStatusTool();
	// Plant a pre-namespacing team: flat dir under TORUS_HOME/teams, spec without
	// a project field, no index entry.
	mkdirSync(path.join(HOME, "teams", "scoped-legacy"), { recursive: true });
	writeFileSync(
		path.join(HOME, "teams", "scoped-legacy", "team.json"),
		JSON.stringify({
			id: "scoped-legacy",
			name: "scoped-legacy",
			objective: "scoped-legacy standing objective",
			members: [{ name: "solo", agent: "builder" }],
			status: "active",
		}),
	);
	registry.registerTeam({
		id: "scoped-legacy",
		name: "scoped-legacy",
		objective: "scoped-legacy standing objective",
		status: "active",
		dir: runtime.teamDir("scoped-legacy"),
		members: [
			{
				id: "scoped-legacy/solo",
				name: "solo",
				agent: "builder",
				model: "test-model",
				status: "idle",
			},
		],
		createdAt: 1000,
	});
	const byDefault = await statusTool.execute("call", {});
	assert.match(byDefault.content[0].text, /^team scoped-legacy \[active\]/m);

	runtime.markTeamStatus("scoped-legacy", "shutdown");
	const reread = runtime.readTeamSpec("scoped-legacy");
	assert.equal(reread?.status, "shutdown");
	assert.equal(reread?.project, CURRENT_PROJECT, "a spec rewrite pins the writing project's key");
	assert.equal(
		runtime.teamDir("scoped-legacy"),
		path.join(HOME, "state", CURRENT_PROJECT, "teams", "scoped-legacy"),
		"the team resolves to the project-scoped store after migration",
	);
	assert.equal(
		existsSync(path.join(HOME, "teams", "scoped-legacy")),
		false,
		"the legacy flat dir is gone after migration",
	);
});
