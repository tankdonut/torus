import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The wake gate: wake markers (team-wake batches, monitor fires) are HELD while
// the agent is mid-run and flushed as ONE combined marker when it settles, so a
// backlog of N pending notifications costs one model turn instead of N. A
// single-entry flush keeps its original customType (renderers and the model see
// the same marker as an ungated emit); only multi-entry flushes wrap in
// torus.wake-batch. Root cause this pins: pi's followUpMode default
// ("one-at-a-time") drains queued follow-ups one run each, so markers handed to
// pi while busy trickle out one wasted turn apiece — and cannot be un-queued by
// team_delete, which made a deleted team wake the session for a minute straight.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-wake-gate-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;

const registry = await import("../extensions/registry.ts");
const gate = await import("../extensions/wake-gate.ts");

const sent = [];
registry.setCustomSender((message, options) => sent.push({ message, options }));

after(() => {
	registry.setCustomSender(() => {});
	gate._resetWakeGateForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

const teamEntry = (team, members) => ({
	customType: "torus.team-wake",
	text: `[torus] team ${team}: ${members.length} members finished`,
	details: { team, members },
});
const monitorEntry = (name) => ({
	customType: "torus.monitor-fired",
	text: `monitor "${name}" failed (exit 1): boom`,
	details: { name, reason: "fail", exit: 1, tail: "boom" },
});

test("idle session: a queued entry flushes immediately, keeping its customType", () => {
	gate._resetWakeGateForTesting();
	sent.length = 0;
	gate._setWakeGateActiveForTesting(false);

	gate.queueWakeEntry(teamEntry("alpha", [{ member: "one" }]));

	assert.equal(sent.length, 1, "idle queue flushes at once");
	assert.equal(sent[0].message.customType, "torus.team-wake", "single entry keeps its type");
	assert.equal(sent[0].options?.triggerTurn, true);
	assert.equal(sent[0].options?.deliverAs, "followUp");
});

test("busy session: entries are held; settle flushes ALL as one torus.wake-batch", () => {
	gate._resetWakeGateForTesting();
	sent.length = 0;
	gate._setWakeGateActiveForTesting(true);

	gate.queueWakeEntry(teamEntry("alpha", [{ member: "one" }]));
	gate.queueWakeEntry(teamEntry("beta", [{ member: "two" }]));
	gate.queueWakeEntry(monitorEntry("ci-probe"));
	assert.equal(sent.length, 0, "nothing may be handed to pi while the agent runs");

	gate.wakeGateAgentSettled();

	assert.equal(sent.length, 1, "settle flushes the whole backlog as ONE marker");
	const { message, options } = sent[0];
	assert.equal(message.customType, "torus.wake-batch");
	assert.equal(options?.triggerTurn, true);
	assert.equal(options?.deliverAs, "followUp");
	const entries = message.details?.entries;
	assert.ok(Array.isArray(entries), "batch carries an entries array");
	assert.equal(entries.length, 3);
	assert.deepEqual(
		entries.map((e) => e.customType),
		["torus.team-wake", "torus.team-wake", "torus.monitor-fired"],
	);
	assert.equal(entries[1].details.team, "beta");
	const text = message.content[0].text;
	assert.match(text, /team alpha/);
	assert.match(text, /team beta/);
	assert.match(text, /ci-probe/);
});

test("agent_start re-arms the hold; entries queued after settle start a new batch", () => {
	gate._resetWakeGateForTesting();
	sent.length = 0;
	gate._setWakeGateActiveForTesting(false);

	gate.wakeGateAgentStart();
	gate.queueWakeEntry(monitorEntry("late"));
	assert.equal(sent.length, 0, "held again once a new run started");

	gate.wakeGateAgentSettled();
	assert.equal(sent.length, 1);
	assert.equal(
		sent[0].message.customType,
		"torus.monitor-fired",
		"single-entry batch keeps its type",
	);
});

test("dropWakeEntries removes matching held entries; the rest still flush", () => {
	gate._resetWakeGateForTesting();
	sent.length = 0;
	gate._setWakeGateActiveForTesting(true);

	gate.queueWakeEntry(teamEntry("alpha", [{ member: "one" }]));
	gate.queueWakeEntry(teamEntry("doomed", [{ member: "ghost" }]));
	gate.queueWakeEntry(monitorEntry("ci-probe"));

	const dropped = gate.dropWakeEntries(
		(e) => e.customType === "torus.team-wake" && e.details?.team === "doomed",
	);
	assert.equal(dropped, 1, "exactly the doomed team's entry is dropped");

	gate.wakeGateAgentSettled();
	assert.equal(sent.length, 1);
	const entries = sent[0].message.details?.entries;
	assert.equal(entries.length, 2, "survivors flush together");
	assert.ok(!entries.some((e) => e.details?.team === "doomed"));
});

test("a flush that finds no sender drops the backlog instead of replaying it later", () => {
	gate._resetWakeGateForTesting();
	registry.setCustomSender(null);
	sent.length = 0;
	gate._setWakeGateActiveForTesting(true);
	gate.queueWakeEntry(teamEntry("gamma", [{ member: "three" }]));
	gate.wakeGateAgentSettled();

	registry.setCustomSender((message, options) => sent.push({ message, options }));
	gate._setWakeGateActiveForTesting(true);
	gate.wakeGateAgentSettled();
	assert.equal(sent.length, 0, "an undeliverable backlog must not resurrect on the next settle");
});
