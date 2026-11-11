import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Background tasks must reach the session transcript on every exit path.
// TORUS_HOME is redirected before the monitor import (log dirs resolve under
// it at spawn time) and TORUS_NOTIFY keeps desktop toasts off the test
// machine.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-bg-test-"));
process.env.HOME = HOME;
process.env.TORUS_HOME = HOME;
process.env.TORUS_NOTIFY = "0";

const registry = await import("../extensions/registry.ts");
const monitor = await import("../extensions/monitor/index.ts");
const gate = await import("../extensions/wake-gate.ts");

after(() => {
	registry.setCustomSender(() => {});
	gate._resetWakeGateForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

function captureCustoms() {
	const customs = [];
	registry.setCustomSender((message, options) => customs.push({ message, options }));
	return customs;
}

async function drain(name) {
	monitor.stopBgTask(name);
	await monitor.pendingBgTasks();
}

test("a clean exit fires one torus.bg-exit with code, duration, and log", async () => {
	const customs = captureCustoms();
	const started = monitor.startBgTask({
		name: "ok-build",
		command: "echo built; sleep 0.15; echo done",
	});
	assert.equal(started.ok, true);
	assert.match(started.logFile, /[/]bg[/]ok-build[.]log$/);
	assert.equal(monitor.validateBgName("ok-build"), null);

	await monitor.pendingBgTasks();

	assert.equal(customs.length, 1);
	const { message: fired } = customs[0];
	assert.equal(fired.customType, "torus.bg-exit");
	assert.match(
		fired.content[0].text,
		/bg "ok-build" exited \(exit 0\) in .+: built done — log: .+/,
	);
	assert.equal(fired.details.code, 0);
	assert.equal(fired.details.reason, "exited");
	assert.ok(typeof fired.details.durationMs === "number" && fired.details.durationMs >= 100);

	assert.ok(existsSync(started.logFile));
	const log = readFileSync(started.logFile, "utf8");
	assert.match(log, /start pid=\d+: echo built/);
	assert.match(log, /built\n.*done\n/s);
	assert.match(log, /exit code=0 signal=null exited in \d+ms/);
});

test("a failing command reports its exit code and stderr tail", async () => {
	const customs = captureCustoms();
	monitor.startBgTask({ name: "bad-build", command: "echo boom >&2; exit 3" });
	await monitor.pendingBgTasks();

	assert.equal(customs.length, 1);
	const { message: fired } = customs[0];
	assert.equal(fired.customType, "torus.bg-exit");
	assert.match(fired.content[0].text, /bg "bad-build" exited \(exit 3\)/);
	assert.equal(fired.details.code, 3);
	assert.match(fired.details.tail, /boom/);
});

test("a long bg output wake truncates from the start like the other wakes", async () => {
	const customs = captureCustoms();
	monitor.startBgTask({
		name: "long-build",
		command: `echo start-marker ${"x".repeat(400)} end-marker`,
	});
	await monitor.pendingBgTasks();

	assert.equal(customs.length, 1);
	const { message: fired } = customs[0];
	assert.match(fired.content[0].text, /: start-marker/);
	assert.ok(!fired.content[0].text.includes("end-marker"), "keeps the start, not the end");
	assert.match(fired.details.tail, /^start-marker/);
	assert.ok(fired.details.tail.endsWith("…"), "a cut tail is marked as truncated");
});

test("torus_bg_stop kills a running task and the wake reports it stopped", async () => {
	const customs = captureCustoms();
	monitor.startBgTask({ name: "long-task", command: "sleep 30" });
	assert.equal(monitor.stopBgTask("long-task"), "stopped");
	assert.equal(monitor.stopBgTask("long-task"), "stopped");
	await monitor.pendingBgTasks();

	assert.equal(customs.length, 1);
	const { message: fired } = customs[0];
	assert.equal(fired.details.reason, "stopped");
	assert.ok(fired.details.code === null || fired.details.code !== 0);
});

test("timeoutSec escalates a stuck command and reports a timeout", async () => {
	const customs = captureCustoms();
	monitor.startBgTask({ name: "stuck", command: "trap '' TERM; sleep 30", timeoutSec: 1 });
	await monitor.pendingBgTasks();

	assert.equal(customs.length, 1);
	const { message: fired } = customs[0];
	assert.equal(fired.details.reason, "timed out");
	assert.equal(fired.details.timedOut, true);
	assert.ok(fired.details.durationMs >= 1000);
}, 15_000);

test("names validate, duplicates refuse, and the cap holds", async () => {
	const customs = captureCustoms();
	assert.notEqual(monitor.validateBgName("Bad Name"), null);
	assert.notEqual(monitor.validateBgName("x".repeat(25)), null);

	assert.equal(monitor.startBgTask({ name: "dup", command: "sleep 30" }).ok, true);
	const again = monitor.startBgTask({ name: "dup", command: "echo second" });
	assert.equal(again.ok, false);
	assert.match(again.error, /still running/);
	await drain("dup");

	for (let i = 1; i <= 5; i += 1) {
		assert.equal(monitor.startBgTask({ name: `cap-${i}`, command: "sleep 30" }).ok, true);
	}
	const sixth = monitor.startBgTask({ name: "cap-6", command: "echo nope" });
	assert.equal(sixth.ok, false);
	assert.match(sixth.error, /cap reached/);
	assert.match(sixth.error, /cap-1/);

	for (let i = 1; i <= 5; i += 1) monitor.stopBgTask(`cap-${i}`);
	await monitor.pendingBgTasks();
	registry.setCustomSender(() => {});
});

test("stopping a missing task reports missing, not an error path", () => {
	assert.equal(monitor.stopBgTask("never-started"), "missing");
});
