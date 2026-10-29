import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The per-member wake-up: when a member finishes an episode — goes idle (or
// stops non-deliberately) while holding an unread outbox report — its episode
// queues; pending episodes flush as ONE combined torus.team-wake marker per
// team after a short coalescing window (tests flush it explicitly).
// Sandbox envs land before any extension import; the spawner is faked so no
// engine runs.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-idle-notify-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";
delete process.env.TORUS_TEAM_NOTIFY;

const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");
const gate = await import("../extensions/wake-gate.ts");

const wakes = [];
registry.setCustomSender((message, options) => {
	if (message.customType === "torus.team-wake") wakes.push({ message, options });
});

const spawned = [];
const spawn = (teamId, spec, _objective, onState, onReport, onStats) => {
	const mailboxDir = path.join(HOME, "teams", teamId, "mailboxes", spec.name);
	spawned.push({ teamId, spec, onState, onReport, onStats, mailboxDir });
	return {
		stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
		forceKill: () => {},
		mailboxDir,
		exited: Promise.resolve(0),
	};
};
team.setMemberSpawnerForTesting(spawn);

function createTool() {
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	return tools.find((t) => t.name === "team_create");
}

async function createTeam(name, members) {
	const result = await createTool().execute(
		"call",
		{ name, objective: "test objective", members },
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => `sess-${name}` } },
	);
	return result.details.teamId;
}

function member(name) {
	return spawned.filter((s) => s.spec.name === name).at(-1);
}

/** Real members append their report to outbox.md before the supervisor drains it. */
function seedOutbox(name, text) {
	const dir = member(name)?.mailboxDir;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	appendFileSync(
		path.join(dir, "outbox.md"),
		`\n[2026-10-03T00:00:00.000Z] FROM ${name}:\n${text}\n`,
		"utf8",
	);
}

after(() => {
	team.setMemberSpawnerForTesting(null);
	registry.setCustomSender(() => {});
	gate._resetWakeGateForTesting();
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

function wakeText(entry) {
	return entry.message.content[0].text;
}

test("per-member wake-up fires on a member's finished episode, independent of siblings", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	await createTeam("alpha", [
		{ name: "one", agent: "builder" },
		{ name: "two", agent: "builder" },
	]);

	member("one").onState({ status: "working", sessionId: "s1" });
	member("two").onState({ status: "working", sessionId: "s2" });
	member("two").onReport("found 3 issues", false);
	seedOutbox("two", "found 3 issues");
	assert.equal(wakes.length, 0, "no wake-up while the member is still working");

	member("two").onState({ status: "idle", sessionId: "s2" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1, "episode fires on flush even though one is still working");
	const wake = wakes[0];
	assert.match(wakeText(wake), /\[torus\] team alpha: @two \(builder\) is idle/);
	assert.match(wakeText(wake), /report: .*found 3 issues/);
	assert.match(wakeText(wake), /team_status/);
	assert.equal(wake.options?.deliverAs, "followUp");
	assert.equal(wake.options?.triggerTurn, true);

	member("two").onState({ status: "idle", sessionId: "s2" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1, "repeat idle ticks must not re-fire the latch");

	member("one").onReport("more findings", false);
	member("one").onState({ status: "idle", sessionId: "s1" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 2, "second member episode fires its own wake-up");
	assert.match(wakeText(wakes[1]), /@one/);
});

test("idle without any unread report stays silent", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	await createTeam("bravo", [{ name: "solo", agent: "builder" }]);

	member("solo").onState({ status: "working", sessionId: "s" });
	member("solo").onState({ status: "idle", sessionId: "s" });
	assert.equal(wakes.length, 0, "idle alone is not news");
});

test("bootstrap 'ready' handshake never wakes the session; the first real report does", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	await createTeam("foxtrot", [{ name: "fresh", agent: "builder" }]);

	member("fresh").onState({ status: "working", sessionId: "s" });
	member("fresh").onReport("ready", true);
	seedOutbox("fresh", "ready");
	member("fresh").onState({ status: "idle", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 0, "handshake report must not arm the wake-up latch");

	member("fresh").onState({ status: "working", sessionId: "s" });
	member("fresh").onReport("task done", false);
	seedOutbox("fresh", "task done");
	member("fresh").onState({ status: "idle", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1, "first real report after mail still wakes the session");
	assert.match(wakeText(wakes[0]), /report: .*task done/);
});

test("non-deliberate crash of the last member wakes the session; team_delete never does", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	const teamId = await createTeam("charlie", [{ name: "sentry", agent: "builder" }]);

	member("sentry").onState({ status: "working", sessionId: "s" });
	member("sentry").onState({ status: "idle", sessionId: "s" });
	await member("sentry").onState({ status: "stopped", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1, "a crashed member is news even without a report");
	assert.match(wakeText(wakes[0]), /@sentry \(builder\) is stopped/);
	assert.match(wakeText(wakes[0]), /stopped unexpectedly/);

	const deltaId = await createTeam("delta", [{ name: "one", agent: "builder" }]);
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	await tools.find((t) => t.name === "team_delete").execute("call", { team: deltaId });
	team.flushTeamWakesForTesting();
	assert.equal(
		wakes.length,
		1,
		"deliberate team_delete must not queue a wake-up (no report was ever read)",
	);

	void teamId;
});

test("episodes within one coalescing window flush as a single combined wake", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	await createTeam("golf", [
		{ name: "scan-a", agent: "builder" },
		{ name: "scan-b", agent: "builder" },
	]);

	for (const name of ["scan-a", "scan-b"]) {
		member(name).onState({ status: "working", sessionId: `s-${name}` });
		member(name).onReport(`${name} done`, false);
		seedOutbox(name, `${name} done`);
		member(name).onState({ status: "idle", sessionId: `s-${name}` });
	}
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1, "two episodes in one window flush as one wake");
	const text = wakeText(wakes[0]);
	assert.match(text, /2 members finished/);
	assert.match(text, /@scan-a/);
	assert.match(text, /@scan-b/);
	assert.match(text, /scan-a done/);
	assert.match(text, /scan-b done/);
	assert.ok(
		Array.isArray(wakes[0].message.details?.members),
		"combined wake carries a members array",
	);
});

test("a member back to working before the flush defers to its next episode", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	await createTeam("hotel", [{ name: "flip", agent: "builder" }]);

	member("flip").onState({ status: "working", sessionId: "s" });
	member("flip").onReport("first report", false);
	seedOutbox("flip", "first report");
	member("flip").onState({ status: "idle", sessionId: "s" });
	member("flip").onState({ status: "working", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 0, "a member back to working is not woken mid-flight");

	member("flip").onState({ status: "idle", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1, "the still-armed latch fires on the next idle episode");
	assert.match(wakeText(wakes[0]), /@flip/);
});

test("team_delete before the flush drops pending wake-ups", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	const teamId = await createTeam("india", [{ name: "ghost", agent: "builder" }]);

	member("ghost").onState({ status: "working", sessionId: "s" });
	member("ghost").onReport("final report", false);
	seedOutbox("ghost", "final report");
	member("ghost").onState({ status: "idle", sessionId: "s" });
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	await tools.find((t) => t.name === "team_delete").execute("call", { team: teamId });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 0, "shutting the team down must not wake the session");
});

test("wake tail quotes the newest outbox entry regardless of heading format", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	await createTeam("juliet", [{ name: "scribe", agent: "builder" }]);

	member("scribe").onState({ status: "working", sessionId: "s" });
	member("scribe").onReport("first entry", false);
	seedOutbox("scribe", `first entry ${"x".repeat(220)}`);
	const dir = member("scribe").mailboxDir;
	appendFileSync(
		path.join(dir, "outbox.md"),
		"\n## 2026-10-06T22:00:00Z — t9 COMPLETE\n\n- Report: NEWEST-FINDING-XYZ done\n",
		"utf8",
	);
	member("scribe").onState({ status: "idle", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 1);
	const text = wakeText(wakes[0]);
	assert.match(text, /NEWEST-FINDING-XYZ/, "tail must quote the newest entry");
	assert.doesNotMatch(text, /first entry/, "tail must not quote the oldest entry");
});

test("a busy session holds the flushed wake; agent settle delivers it once", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	wakes.length = 0;
	gate._setWakeGateActiveForTesting(true);
	await createTeam("kilo", [{ name: "held", agent: "builder" }]);

	member("held").onState({ status: "working", sessionId: "s" });
	member("held").onReport("done waiting", false);
	seedOutbox("held", "done waiting");
	member("held").onState({ status: "idle", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 0, "the coalesced wake must not reach pi while the agent runs");

	gate.wakeGateAgentSettled();
	assert.equal(wakes.length, 1, "settle flushes the held wake exactly once");
	assert.match(wakeText(wakes[0]), /@held/);
	gate._setWakeGateActiveForTesting(false);
});

test("team_delete drops a wake already held for a busy session (the post-delete churn)", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	wakes.length = 0;
	gate._setWakeGateActiveForTesting(true);
	const teamId = await createTeam("lima", [{ name: "ghost", agent: "builder" }]);

	member("ghost").onState({ status: "working", sessionId: "s" });
	member("ghost").onReport("final report", false);
	seedOutbox("ghost", "final report");
	member("ghost").onState({ status: "idle", sessionId: "s" });
	team.flushTeamWakesForTesting();
	assert.equal(wakes.length, 0, "held while the lead is mid-run");

	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	await tools.find((t) => t.name === "team_delete").execute("call", { team: teamId });
	gate.wakeGateAgentSettled();
	assert.equal(
		wakes.length,
		0,
		"a wake held for a deleted team must never reach the session, not even at settle",
	);
	gate._setWakeGateActiveForTesting(false);
});

test("TORUS_TEAM_NOTIFY=0 suppresses the wake-up", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	process.env.TORUS_TEAM_NOTIFY = "0";
	try {
		await createTeam("echo", [{ name: "solo", agent: "builder" }]);
		member("solo").onState({ status: "working", sessionId: "s" });
		member("solo").onReport("findings", false);
		member("solo").onState({ status: "idle", sessionId: "s" });
		team.flushTeamWakesForTesting();
		assert.equal(wakes.length, 0, "kill switch must silence the wake-up");
	} finally {
		delete process.env.TORUS_TEAM_NOTIFY;
	}
});

test("mailbox polls read only deltas: an unchanged inbox costs zero byte reads", async () => {
	const runtime = await import("../extensions/team-runtime.ts");
	const dir = path.join(HOME, "delta-poll");
	mkdirSync(dir, { recursive: true });
	const mailbox = path.join(dir, "inbox.md");
	const cursorFile = path.join(dir, "inbox.cursor");
	const line = "[2026-10-25T00:00:00.000Z] FROM lead:\ndo the thing\n";
	writeFileSync(mailbox, line.repeat(40_000), "utf8");
	const size = statSync(mailbox).size;
	assert.ok(size >= 2_000_000, `fixture must reach 2MB, got ${size} bytes`);

	const cursor = { value: size };
	runtime._resetDeltaBytesReadForTesting();
	const began = performance.now();
	for (let poll = 0; poll < 100; poll++) {
		assert.equal(
			runtime.readDelta(mailbox, cursor, cursorFile),
			"",
			"an unchanged inbox polls as empty",
		);
	}
	const elapsed = performance.now() - began;
	assert.equal(
		runtime._deltaBytesReadForTesting(),
		0,
		"100 unchanged polls must not read a single byte",
	);
	assert.ok(elapsed < 200, `100 stat-only polls must return instantly, took ${elapsed}ms`);

	const appendage = "\nNEW MAIL: ship it\n";
	appendFileSync(mailbox, appendage, "utf8");
	const delta = runtime.readDelta(mailbox, cursor, cursorFile);
	assert.equal(delta, appendage, "one append yields exactly the appended delta");
	assert.equal(
		runtime._deltaBytesReadForTesting(),
		appendage.length,
		"the read must be delta-sized, never file-sized",
	);
	assert.equal(readFileSync(cursorFile, "utf8"), String(size + appendage.length));
});
