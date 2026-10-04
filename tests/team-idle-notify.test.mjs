import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The per-member wake-up: when a member finishes an episode — goes idle (or
// stops non-deliberately) while holding an unread outbox report — exactly one
// torus.team-wake marker (triggerTurn) is queued, regardless of sibling
// member states.
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

const wakes = [];
registry.setCustomSender((message, options) => {
	if (message.customType === "torus.team-wake") wakes.push({ message, options });
});

const spawned = [];
const spawn = (teamId, spec, _objective, onState, onReport, onStats) => {
	const mailboxDir = path.join(HOME, ".torus", "teams", teamId, "mailboxes", spec.name);
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
	assert.equal(wakes.length, 1, "episode fires immediately even though one is still working");
	const wake = wakes[0];
	assert.match(wakeText(wake), /\[torus\] team alpha: @two \(builder\) is idle/);
	assert.match(wakeText(wake), /report: .*found 3 issues/);
	assert.match(wakeText(wake), /team_status/);
	assert.equal(wake.options?.deliverAs, "followUp");
	assert.equal(wake.options?.triggerTurn, true);

	member("two").onState({ status: "idle", sessionId: "s2" });
	assert.equal(wakes.length, 1, "repeat idle ticks must not re-fire the latch");

	member("one").onReport("more findings", false);
	member("one").onState({ status: "idle", sessionId: "s1" });
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
	assert.equal(wakes.length, 0, "handshake report must not arm the wake-up latch");

	member("fresh").onState({ status: "working", sessionId: "s" });
	member("fresh").onReport("task done", false);
	seedOutbox("fresh", "task done");
	member("fresh").onState({ status: "idle", sessionId: "s" });
	assert.equal(wakes.length, 1, "first real report after mail still wakes the session");
	assert.match(wakeText(wakes[0]), /report: .*task done/);
});

test("non-deliberate crash of the last member wakes the session; team_delete never does", async () => {
	registry.resetRegistryForTesting();
	wakes.length = 0;
	const teamId = await createTeam("charlie", [{ name: "sentry", agent: "builder" }]);

	member("sentry").onState({ status: "working", sessionId: "s" });
	member("sentry").onState({ status: "idle", sessionId: "s" });
	member("sentry").onState({ status: "stopped", sessionId: "s" });
	assert.equal(wakes.length, 1, "a crashed member is news even without a report");
	assert.match(wakeText(wakes[0]), /@sentry \(builder\) is stopped/);
	assert.match(wakeText(wakes[0]), /stopped unexpectedly/);

	const deltaId = await createTeam("delta", [{ name: "one", agent: "builder" }]);
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	await tools.find((t) => t.name === "team_delete").execute("call", { team: deltaId });
	assert.equal(
		wakes.length,
		1,
		"deliberate team_delete must not queue a wake-up (no report was ever read)",
	);

	void teamId;
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
		assert.equal(wakes.length, 0, "kill switch must silence the wake-up");
	} finally {
		delete process.env.TORUS_TEAM_NOTIFY;
	}
});
