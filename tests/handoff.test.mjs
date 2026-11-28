import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-handoff-"));
process.env["TORUS_HOME"] = home;

const {
	handoffRecommendation,
	handoffBlocker,
	resolveBrief,
	resolveAddition,
	copyGoalToSession,
	rebindWorkToSession,
	kickoffText,
} = await import("../extensions/handoff/index.ts");
const goal = await import("../extensions/goal/index.ts");
const work = await import("../extensions/work/index.ts");

const A = "aaaaaaaa-1111-7111-8111-111111111111";
const B = "bbbbbbbb-2222-7222-8222-222222222222";

test("handoffRecommendation stays silent without a completed plan execution", () => {
	assert.equal(
		handoffRecommendation({ percent: 90, completedAt: null, lastNotifiedAt: null }),
		null,
	);
});

test("handoffRecommendation stays silent under the context threshold", () => {
	assert.equal(handoffRecommendation({ percent: 49, completedAt: 5, lastNotifiedAt: null }), null);
	assert.equal(
		handoffRecommendation({ percent: null, completedAt: 5, lastNotifiedAt: null }),
		null,
	);
});

test("handoffRecommendation fires once per completion, at or above the threshold", () => {
	const first = handoffRecommendation({ percent: 62, completedAt: 1000, lastNotifiedAt: null });
	assert.match(first, /62%/);
	assert.match(first, /\/handoff/);
	// Same completion announced again: silence.
	assert.equal(
		handoffRecommendation({ percent: 62, completedAt: 1000, lastNotifiedAt: 1000 }),
		null,
	);
	// A newer completion re-arms the note.
	assert.match(
		handoffRecommendation({ percent: 70, completedAt: 2000, lastNotifiedAt: 1000 }),
		/70%/,
	);
});

test("handoffBlocker refuses until the boundary is quiet, then allows", () => {
	const quiet = {
		isIdle: true,
		pendingMessages: false,
		wakePending: 0,
		liveTasks: 0,
		runningDelegations: 0,
	};
	assert.equal(handoffBlocker(quiet), null);
	assert.match(handoffBlocker({ ...quiet, isIdle: false }), /settle/);
	assert.match(handoffBlocker({ ...quiet, pendingMessages: true }), /queued messages/);
	assert.match(handoffBlocker({ ...quiet, wakePending: 2 }), /2 wake marker/);
	assert.match(handoffBlocker({ ...quiet, runningDelegations: 3 }), /3 delegation/);
	assert.match(handoffBlocker({ ...quiet, liveTasks: 1 }), /monitor\/bg/);
	// Order matters: earlier conditions win so the message names the first fix.
	assert.match(
		handoffBlocker({
			isIdle: false,
			pendingMessages: true,
			wakePending: 1,
			liveTasks: 1,
			runningDelegations: 1,
		}),
		/settle/,
	);
});

test("resolveBrief prefers explicit command args over a tool request", () => {
	assert.equal(resolveBrief("next slice", "tool brief"), "next slice");
	assert.equal(resolveBrief("  ", "tool brief"), "tool brief");
	assert.equal(resolveBrief("", null), "");
});

test("resolveAddition trims a tool request and reads absence as empty", () => {
	assert.equal(resolveAddition("  keep the API additive  "), "keep the API additive");
	assert.equal(resolveAddition("   "), "");
	assert.equal(resolveAddition(null), "");
});

test("copyGoalToSession clones the goal state and reports a missing source", () => {
	const state = { goal: "ship the thing", status: "active", createdAt: 7, notes: ["a"] };
	goal.writeGoal(A, state);
	assert.equal(goal.readGoal(B), null);
	assert.equal(copyGoalToSession(A, B), true);
	assert.deepEqual(goal.readGoal(B), state);
	assert.equal(copyGoalToSession("no-such-session", B), false);
});

test("rebindWorkToSession moves the active binding and leaves others alone", () => {
	work.writeWorkState({
		slug: "handoff-test-active",
		planPath: "/tmp/plan.md",
		sessionId: A,
		status: "active",
		createdAt: 1,
		startedAt: 1,
		lastActiveAt: 1,
		completedAt: null,
	});
	work.writeWorkState({
		slug: "handoff-test-done",
		planPath: "/tmp/plan.md",
		sessionId: A,
		status: "complete",
		createdAt: 1,
		startedAt: 1,
		lastActiveAt: 2,
		completedAt: 2,
	});
	const rebound = rebindWorkToSession(A, B);
	assert.equal(rebound?.sessionId, B);
	const states = work.listWorkStates();
	assert.equal(
		states.find((s) => s.slug === "handoff-test-active")?.sessionId,
		B,
		"active binding should point at the new session",
	);
	assert.equal(
		states.find((s) => s.slug === "handoff-test-done")?.sessionId,
		A,
		"completed binding stays with the old session",
	);
	assert.equal(rebindWorkToSession("no-such-session", B), null);
});

test("kickoffText composes continuity note, objective, and brief", () => {
	const goalState = { goal: "iterate the roadmap", status: "active", createdAt: 1, notes: [] };
	const withBrief = kickoffText("Start slice 3.", goalState);
	assert.match(withBrief, /\[torus handoff\]/);
	assert.match(withBrief, /Standing objective \(active\): iterate the roadmap/);
	assert.match(withBrief, /Start slice 3\./);
	const withoutBrief = kickoffText("", goalState);
	assert.match(withoutBrief, /Continue the standing work/);
	assert.doesNotMatch(withoutBrief, /Start slice 3\./);
});

test("kickoffText appends the model's addition as its own labeled section after the brief", () => {
	const withAddition = kickoffText("Start slice 3.", null, "  Prefer additive changes.  ");
	assert.match(withAddition, /\[torus handoff addition[^\]]*\]/);
	assert.match(withAddition, /Prefer additive changes\./);
	// The brief still leads; the addition follows it, never replaces it.
	assert.ok(
		withAddition.indexOf("Start slice 3.") < withAddition.indexOf("Prefer additive changes."),
	);
	// No addition: no section header leaks into the kickoff.
	const withoutAddition = kickoffText("Start slice 3.", null);
	assert.doesNotMatch(withoutAddition, /torus handoff addition/);
	assert.doesNotMatch(kickoffText("Start slice 3.", null, "   "), /torus handoff addition/);
});
