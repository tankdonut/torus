import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

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

// Built-in chain providers are credential-gated at resolution: dummy env
// values (presence only — nothing reads them) keep the shorthand-to-chain-head
// resolution hermetic instead of depending on the machine's real agent dir.
const PREV_ZAI_KEY = process.env.ZAI_API_KEY;
const PREV_OPENCODE_KEY = process.env.OPENCODE_API_KEY;
process.env.ZAI_API_KEY = "torus-test-dummy";
process.env.OPENCODE_API_KEY = "torus-test-dummy";

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");
const team = await import("../extensions/team/index.ts");
const runtime = await import("../extensions/team/team-runtime.ts");

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
	if (PREV_ZAI_KEY === undefined) delete process.env.ZAI_API_KEY;
	else process.env.ZAI_API_KEY = PREV_ZAI_KEY;
	if (PREV_OPENCODE_KEY === undefined) delete process.env.OPENCODE_API_KEY;
	else process.env.OPENCODE_API_KEY = PREV_OPENCODE_KEY;
	rmSync(HOME, { recursive: true, force: true });
});

// Dead attempts enter the session's no-work cooldown; clear it between tests
// so each starts from the unfiltered chain.
beforeEach(() => roster.resetFailureMemoForTesting());

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

// (dedup test removed: a member registers exactly once now — startDelegation
// alone creates the record, the publish side-channel is gone, so a member
// cannot appear twice in any list and there is no filter left to pin.)

test("member crash emits ok:false result and fails the record with the last report as summary", async () => {
	registry.resetRegistryForTesting();
	const { teamId, customs } = await createTeam("bravo", [{ name: "sentry", agent: "builder" }]);
	const memberId = `${teamId}/sentry`;

	spawner.spawned.at(-1).onReport("found 3 issues\nqueued fixes", false);
	await spawner.spawned.at(-1).onState({ status: "stopped", sessionId: "sess-bravo-sentry" });

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
	await new Promise((resolve) => setTimeout(resolve, 0));
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

test("fan-out with one model-error run marks it not-ok with its error text on its own wake line", async () => {
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

	const results = customs.filter(
		(m) => m.customType === "torus.delegation-result" && typeof m.details.handle === "string",
	);
	assert.equal(results.length, 2, "one directly emitted marker per run");
	const sick = results.find((m) => m.details.handle === "sick");
	const well = results.find((m) => m.details.handle === "well");
	assert.ok(sick && well, "both runs deliver a marker keyed by bare handle");
	assert.equal(sick.details.ok, false, "the model-error run is marked not-ok");
	assert.equal(sick.details.agent, "builder");
	assert.equal(typeof sick.details.delegationId, "string", "the failed marker stays clickable");
	assert.match(sick.content[0].text, /delegation "@sick" failed/, "the failed run renders failed");
	assert.match(
		sick.content[0].text,
		/socket hang up/,
		"the engine error text reaches its own line",
	);
	assert.equal(well.details.ok, true);
	assert.match(well.content[0].text, /delegation "@well" finished/);
	registry.setCustomSender(() => {});
});

test("fan-out per-run wake entries resolve to registry records carrying the per-run cost", async () => {
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

	const results = customs.filter(
		(m) => m.customType === "torus.delegation-result" && typeof m.details.handle === "string",
	);
	assert.equal(results.length, 2, "one directly emitted marker per run");
	const records = registry.listDelegations();
	const costOf = (handle) => {
		const marker = results.find((m) => m.details.handle === handle);
		assert.ok(marker, `${handle} delivers its own marker`);
		assert.equal(typeof marker.details.delegationId, "string", `${handle}'s marker is clickable`);
		const record = records.find((r) => r.id === marker.details.delegationId);
		assert.ok(record, "the marker's id resolves to its registry record");
		return record.cost;
	};
	assert.equal(costOf("scout"), 0.01, "the cheap run's record carries its engine cost");
	assert.equal(costOf("heavy"), 0.0315, "the pricey run's record carries its engine cost");
	registry.setCustomSender(() => {});
});

test("mixed fan-out batch: the failed run's entry carries no id, the success's resolves to its record", async () => {
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

	const results = customs.filter(
		(m) => m.customType === "torus.delegation-result" && typeof m.details.handle === "string",
	);
	assert.equal(results.length, 2, "one directly emitted marker per run");
	const doomed = results.find((m) => m.details.handle === "doomed");
	const scout = results.find((m) => m.details.handle === "scout");
	assert.ok(doomed && scout, "both runs deliver a marker keyed by bare handle");
	assert.equal(doomed.details.ok, false, "the unknown-agent run is marked not-ok");
	assert.equal(
		doomed.details.delegationId,
		undefined,
		"a run that never minted an id carries none",
	);
	assert.match(
		doomed.content[0].text,
		/delegation "@doomed" failed/,
		"the failed run renders failed",
	);
	assert.equal(scout.details.ok, true);
	assert.equal(typeof scout.details.delegationId, "string", "the success's id is a real string");
	const record = registry.listDelegations().find((r) => r.id === scout.details.delegationId);
	assert.ok(record, "the success's id resolves to its registry record");
	assert.ok(
		Math.abs(record.cost - 0.0315) < 1e-9,
		`the record must carry the success's engine cost, got ${record.cost}`,
	);
	registry.setCustomSender(() => {});
});
