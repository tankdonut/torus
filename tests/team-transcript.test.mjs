import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Team lifecycle must reach the transcript and the delegation registry. The
// sandbox envs land before any extension import: registry derives its dirs
// from TORUS_HOME, team-runtime derives TEAMS_ROOT from HOME, and TORUS_NOTIFY
// keeps delegation toasts off the test desktop. spawnMember is substituted
// with a fake so team/index.ts wiring is exercised without engine children.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-transcript-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");

function fakeSpawner() {
	const spawned = [];
	const spawn = (teamId, spec, _objective, onState, onReport, onStats) => {
		spawned.push({ teamId, spec, onState, onReport, onStats });
		return {
			stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
			forceKill: () => {},
			mailboxDir: path.join(HOME, ".torus", "teams", teamId, "mailboxes", spec.name),
			exited: Promise.resolve(0),
		};
	};
	return { spawned, spawn };
}

const spawner = fakeSpawner();
team.setMemberSpawnerForTesting(spawner.spawn);

function registeredTools() {
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	return tools;
}

async function createTeam(name, members) {
	const customs = [];
	registry.setCustomSender((message) => customs.push(message));
	const createTool = registeredTools().find((t) => t.name === "team_create");
	const result = await createTool.execute(
		"call",
		{ name, objective: "test objective", members },
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => `sess-${name}` } },
	);
	assert.ok(result.details.teamId, "team_create must return a teamId");
	return { teamId: result.details.teamId, customs };
}

function memberRecord(memberId) {
	return registry.listDelegations().find((r) => r.id === memberId);
}

after(() => {
	team.setMemberSpawnerForTesting(null);
	registry.setCustomSender(() => {});
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

test("team_create emits one combined start marker and creates running delegation records", async () => {
	registry.resetRegistryForTesting();
	const { teamId, customs } = await createTeam("alpha", [{ name: "scout", agent: "builder" }]);
	const memberId = `${teamId}/scout`;

	const starts = customs.filter((m) => m.customType === "torus.delegation-start");
	assert.equal(starts.length, 1, "team_create emits exactly one combined start marker");
	const start = starts[0];
	assert.equal(start.display, true);
	assert.deepEqual(start.content, [{ type: "text", text: "@scout (builder) spawned" }]);
	assert.equal(start.details.agent, "team");
	assert.equal(start.details.handle, "alpha");
	assert.equal(start.details.team, teamId);
	assert.deepEqual(start.details.members, ["scout"]);

	const record = memberRecord(memberId);
	assert.ok(record, "member must be onboarded into the delegation registry");
	assert.equal(record.status, "running");
	assert.equal(record.agent, "builder");
	assert.equal(record.handle, "scout");
	assert.equal(record.parentSession, "sess-alpha");
	assert.match(record.logFile, /\.log$/);
});

test("multi-member create emits a single combined start marker listing every member", async () => {
	registry.resetRegistryForTesting();
	const { customs } = await createTeam("golf", [
		{ name: "one", agent: "builder" },
		{ name: "two", agent: "explorer" },
	]);
	const starts = customs.filter((m) => m.customType === "torus.delegation-start");
	assert.equal(starts.length, 1, "one marker for the whole batch, not one per member");
	assert.deepEqual(starts[0].content, [
		{ type: "text", text: "@one (builder), @two (explorer) spawned" },
	]);
	assert.deepEqual(starts[0].details.members, ["one", "two"]);
});

test("team_status lists one merged line per member", async () => {
	registry.resetRegistryForTesting();
	const { teamId } = await createTeam("hotel", [{ name: "solo", agent: "builder" }]);
	spawner.spawned.at(-1).onState({ status: "idle", sessionId: "sess-hotel-solo" });

	const statusTool = registeredTools().find((t) => t.name === "team_status");
	const result = await statusTool.execute("call", { team: teamId });
	const text = result.content[0].text;
	assert.ok(text.startsWith("team hotel [active] — test objective"), "objective header first");
	const memberLines = text.split("\n").filter((line) => line.startsWith("- "));
	assert.equal(memberLines.length, 1, "roster and report sections merged into one line");
	assert.match(memberLines[0], /^- solo \(builder\) · idle — /);
});

test("external runs exclude member ids already onboarded as delegation records", async () => {
	registry.resetRegistryForTesting();
	const { teamId } = await createTeam("india", [{ name: "solo", agent: "builder" }]);
	const memberId = `${teamId}/solo`;
	assert.ok(
		registry.listExternalRuns().some((r) => r.id === memberId),
		"member is published as an external run",
	);
	assert.ok(
		!registry.listExternalRunsExcludingDelegations().some((r) => r.id === memberId),
		"fleet views must not list the member twice",
	);
});

test("member crash emits ok:false result and fails the record with the last report as summary", async () => {
	registry.resetRegistryForTesting();
	const { teamId, customs } = await createTeam("bravo", [{ name: "sentry", agent: "builder" }]);
	const memberId = `${teamId}/sentry`;

	spawner.spawned.at(-1).onReport("found 3 issues\nqueued fixes");
	spawner.spawned.at(-1).onState({ status: "stopped", sessionId: "sess-bravo-sentry" });

	const record = memberRecord(memberId);
	assert.equal(record.status, "failed");
	assert.equal(record.sessionId, "sess-bravo-sentry");
	assert.equal(record.text, "found 3 issues\nqueued fixes");

	const result = customs.find((m) => m.customType === "torus.delegation-result");
	assert.ok(result, "delegation-result marker missing for member crash");
	assert.equal(result.display, true);
	assert.deepEqual(result.content, [{ type: "text", text: "sentry failed" }]);
	assert.equal(result.details.ok, false);
	assert.equal(result.details.delegationId, memberId);
	assert.equal(result.details.handle, "sentry");
	assert.equal(result.details.team, teamId);
	assert.equal(typeof result.details.durationMs, "number");
});

test("registry steer reaches the member mailbox and registry stop finishes the record deliberately", async () => {
	registry.resetRegistryForTesting();
	const { teamId, customs } = await createTeam("charlie", [{ name: "worker", agent: "builder" }]);
	const memberId = `${teamId}/worker`;

	assert.equal(registry.steerDelegation(memberId, "please check the flaky test"), true);
	const inbox = readFileSync(
		path.join(HOME, ".torus", "teams", teamId, "mailboxes", "worker", "inbox.md"),
		"utf8",
	);
	assert.match(inbox, /please check the flaky test/);

	assert.equal(registry.stopDelegation(memberId), true);
	assert.equal(memberRecord(memberId).status, "done");

	const result = customs.find((m) => m.customType === "torus.delegation-result");
	assert.ok(result, "fleet stop must surface a result marker");
	assert.deepEqual(result.content, [{ type: "text", text: "worker stopped" }]);
	assert.equal(result.details.ok, true);
});

test("team_delete deliberately finishes every member delegation record", async () => {
	registry.resetRegistryForTesting();
	const { teamId, customs } = await createTeam("delta", [
		{ name: "one", agent: "builder" },
		{ name: "two", agent: "builder" },
	]);

	const deleteTool = registeredTools().find((t) => t.name === "team_delete");
	const result = await deleteTool.execute("call", { team: teamId });
	assert.match(result.content[0].text, /shut down/);

	for (const name of ["one", "two"]) {
		assert.equal(memberRecord(`${teamId}/${name}`).status, "done", `${name} must be done`);
	}
	const results = customs.filter(
		(m) => m.customType === "torus.delegation-result" && m.details.team === teamId,
	);
	assert.equal(
		results.length,
		1,
		"team_delete emits one combined result marker, not one per member",
	);
	const combined = results[0];
	assert.equal(combined.details.agent, "team");
	assert.deepEqual(combined.details.members, ["one", "two"]);
	assert.equal(combined.details.ok, true);
	assert.match(
		combined.content[0].text,
		/^@one, @two stopped \(team .+ shut down\)$/,
		"combined marker names every member",
	);
});

test("team_respawn starts a fresh record and stale supervisor callbacks cannot finish it", async () => {
	registry.resetRegistryForTesting();
	const { teamId, customs } = await createTeam("echo", [{ name: "solo", agent: "builder" }]);
	const memberId = `${teamId}/solo`;
	const first = spawner.spawned.at(-1);
	first.onState({ status: "stopped", sessionId: "sess-echo-1" });
	assert.equal(memberRecord(memberId).status, "failed");
	const startMarkersBefore = customs.filter(
		(m) => m.customType === "torus.delegation-start",
	).length;

	const respawnTool = registeredTools().find((t) => t.name === "team_respawn");
	await respawnTool.execute("call", { team: teamId });

	assert.equal(memberRecord(memberId).status, "running", "respawn must start a fresh record");
	assert.equal(
		customs.filter((m) => m.customType === "torus.delegation-start").length,
		startMarkersBefore + 1,
		"respawn emits a new start marker",
	);

	const second = spawner.spawned.at(-1);
	assert.notEqual(second, first, "respawn must spawn a new supervisor closure");
	first.onState({ status: "stopped", sessionId: "stale" });
	assert.equal(memberRecord(memberId).status, "running", "stale callback must be ignored");
	second.onState({ status: "stopped", sessionId: "sess-echo-2" });
	assert.equal(memberRecord(memberId).status, "failed");
	assert.equal(memberRecord(memberId).sessionId, "sess-echo-2");
});
