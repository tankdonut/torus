import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Team lifecycle must reach the transcript and the delegation registry. The
// sandbox envs land before any extension import: registry and team-runtime
// derive their dirs from TORUS_HOME, and TORUS_NOTIFY
// keeps delegation toasts off the test desktop. spawnMember is substituted
// with a fake so team/index.ts wiring is exercised without engine children.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-transcript-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");
const runtime = await import("../extensions/team-runtime.ts");

function fakeSpawner() {
	const spawned = [];
	const spawn = (teamId, spec, _objective, onState, onReport, onStats) => {
		spawned.push({ teamId, spec, onState, onReport, onStats });
		return {
			stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
			forceKill: () => {},
			mailboxDir: path.join(HOME, "teams", teamId, "mailboxes", spec.name),
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

test("unknown-team tool results carry isError so the TUI paints them red", async () => {
	registry.resetRegistryForTesting();
	const statusTool = registeredTools().find((t) => t.name === "team_status");
	const result = await statusTool.execute("call", { team: "no-such-team" });
	assert.match(result.content[0].text, /No such team/);
	assert.equal(result.isError, true, "unknown team must flag isError");
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

	spawner.spawned.at(-1).onReport("found 3 issues\nqueued fixes", false);
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
		path.join(runtime.teamDir(teamId), "mailboxes", "worker", "inbox.md"),
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

test("fan-out with one model-error run marks it not-ok with its error text in the coalesced marker", async () => {
	registry.resetRegistryForTesting();
	// One engine, two behaviors: the "error probe" task ends in a dead turn
	// carrying the engine's first-class error signal (stopReason "error" +
	// errorMessage); every other task gets a single healthy turn.
	const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fanout-error-"));
	const MIXED_ENGINE = path.join(ENGINE_DIR, "mixed-engine.sh");
	writeFileSync(
		MIXED_ENGINE,
		[
			"#!/bin/sh",
			'case "$*" in *"error probe"*)',
			'\techo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial verdict"}],"usage":{"input":100,"output":10},"stopReason":"stop"}}\'',
			'\techo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial verdict"}],"usage":{"input":0,"output":0},"stopReason":"error","errorMessage":"socket hang up"}}\'',
			"\t;;",
			'*) echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20},"stopReason":"stop"}}\' ;;',
			"esac",
			"exit 0",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(MIXED_ENGINE, 0o755);
	process.env.TORUS_ENGINE_BIN = MIXED_ENGINE;

	const customs = [];
	registry.setCustomSender((message) => customs.push(message));
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	try {
		const result = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "error probe", handle: "sick" },
					{ agent: "builder", task: "healthy probe", handle: "well" },
				],
			},
			undefined,
			undefined,
			{
				sessionManager: { getSessionId: () => "sess-fanout-error" },
				ui: { setStatus: () => {} },
			},
		);
		assert.equal(result.details.ok, 1, "exactly one run succeeds");
	} finally {
		delete process.env.TORUS_ENGINE_BIN;
		rmSync(ENGINE_DIR, { recursive: true, force: true });
	}

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1, "one combined marker for the batch");
	const combined = results[0];
	assert.equal(combined.details.ok, false, "the model-error run drags the batch marker to not-ok");
	assert.match(combined.content[0].text, /@sick ✗/, "the model-error run is rendered failed");
	assert.match(combined.content[0].text, /@well ✓/, "the healthy run is still rendered ok");
	assert.deepEqual(
		combined.details.errors,
		["@sick: socket hang up"],
		"the coalesced marker carries the engine error text per failed run",
	);
	assert.equal(combined.details.runs, 2);
	assert.equal(
		combined.details.delegationIds.length,
		2,
		"both runs rode the batch with delegation ids",
	);
	registry.setCustomSender(() => {});
});

test("fan-out coalesced result marker carries per-run and summed cost", async () => {
	registry.resetRegistryForTesting();
	// Fake engines priced by task text so the two runs settle with distinct
	// engine-computed totals; the JSON fallback consumes one message_end each.
	const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fanout-cost-"));
	const PRICED_ENGINE = path.join(ENGINE_DIR, "priced-engine.sh");
	writeFileSync(
		PRICED_ENGINE,
		[
			"#!/bin/sh",
			'case "$*" in',
			'  *"cheap run"*) echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"cheap done"}],"usage":{"input":10,"output":20,"cacheRead":100,"cacheWrite":10,"cost":{"total":0.01}}}}\' ;;',
			'  *) echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"cacheRead":900,"cacheWrite":100,"cost":{"total":0.0315}}}}\' ;;',
			"esac",
			"exit 0",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(PRICED_ENGINE, 0o755);
	process.env.TORUS_ENGINE_BIN = PRICED_ENGINE;

	const customs = [];
	registry.setCustomSender((message) => customs.push(message));
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	try {
		const result = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "cheap run", handle: "scout" },
					{ agent: "builder", task: "pricey run", handle: "heavy" },
				],
			},
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "sess-fanout-cost" }, ui: { setStatus: () => {} } },
		);
		assert.equal(result.details.ok, 2, "both runs succeed under the fake engines");
	} finally {
		delete process.env.TORUS_ENGINE_BIN;
		rmSync(ENGINE_DIR, { recursive: true, force: true });
	}

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1, "simultaneous completions flush as one combined marker");
	const combined = results[0];
	assert.equal(combined.details.runs, 2);
	assert.deepEqual(
		[...combined.details.costs].sort((a, b) => a - b),
		[0.01, 0.0315],
		"per-run costs ride the marker details",
	);
	assert.ok(
		Math.abs(combined.details.cost - 0.0415) < 1e-9,
		`summed batch cost expected 0.0415, got ${combined.details.cost}`,
	);
	registry.setCustomSender(() => {});
});

test("mixed fan-out batch keeps costs aligned with delegationIds when a run fails early", async () => {
	registry.resetRegistryForTesting();
	// One priced engine for the succeeding run; the failing run targets an
	// unknown agent so runDelegation bails before minting a delegation id —
	// the same null-id coalesce entry a thrown run produces via the catch path.
	const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fanout-mixed-"));
	const PRICED_ENGINE = path.join(ENGINE_DIR, "priced-engine.sh");
	writeFileSync(
		PRICED_ENGINE,
		[
			"#!/bin/sh",
			'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"cost":{"total":0.0315}}}}\'',
			"exit 0",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(PRICED_ENGINE, 0o755);
	process.env.TORUS_ENGINE_BIN = PRICED_ENGINE;

	const customs = [];
	registry.setCustomSender((message) => customs.push(message));
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	try {
		const result = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "ghost", task: "doomed run", handle: "doomed" },
					{ agent: "builder", task: "priced run", handle: "scout" },
				],
			},
			undefined,
			undefined,
			{ sessionManager: { getSessionId: () => "sess-fanout-mixed" }, ui: { setStatus: () => {} } },
		);
		assert.equal(result.details.ok, 1, "exactly one run succeeds");
	} finally {
		delete process.env.TORUS_ENGINE_BIN;
		rmSync(ENGINE_DIR, { recursive: true, force: true });
	}

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1, "near-simultaneous settle flushes one combined marker");
	const combined = results[0];
	assert.equal(combined.details.runs, 2, "both runs ride the batch");
	assert.equal(
		combined.details.delegationIds.length,
		1,
		"only the succeeding run contributes a delegation id",
	);
	assert.equal(combined.details.costs.length, 1, "the failed run contributes no cost entry");
	assert.ok(
		Math.abs(combined.details.costs[0] - 0.0315) < 1e-9,
		`costs[0] must be the success's engine cost, got ${combined.details.costs[0]}`,
	);
	assert.equal(combined.details.delegationIds[0].length > 0, true, "the id is a real string");
	registry.setCustomSender(() => {});
});
