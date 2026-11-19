import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Monitor fires must reach the session transcript. TORUS_HOME is redirected
// before the monitor import (log dirs resolve under it at call time) and
// TORUS_NOTIFY keeps desktop toasts off the test machine.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-monitor-fired-test-"));
process.env.HOME = HOME;
process.env.TORUS_HOME = HOME;
process.env.TORUS_NOTIFY = "0";
// Idle fires deliver instantly; the debounce window is unit-tested in wake-gate.test.mjs.
process.env.TORUS_WAKE_COALESCE_MS = "0";

const registry = await import("../extensions/registry.ts");
const monitor = await import("../extensions/monitor/index.ts");
const gate = await import("../extensions/wake-gate.ts");
// canonical project key (linked worktrees key on the main checkout) — the
// same derivation production uses, never a raw-cwd reimplementation
const { projectKeyFor: projectKey } = await import("../extensions/fsutil.ts");

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

function recordingPi() {
	const calls = { registerTool: [], on: [] };
	const pi = {
		registerTool: (tool) => calls.registerTool.push(tool.name),
		on: (name) => calls.on.push(name),
	};
	return { pi, calls };
}

/** Sets TORUS_* vars for the registration-time reads and restores them after. */
function withEnv(vars, run) {
	const prev = {};
	for (const [key, value] of Object.entries(vars)) {
		prev[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function fakeEntry(overrides) {
	return {
		name: "probe",
		command: "echo one",
		intervalSec: 5,
		stopOn: "change",
		lastHash: null,
		checks: 0,
		timer: null,
		checkPromise: null,
		...overrides,
	};
}

test("registration: ci profile registers nothing (monitor and bg commands run unjudged and unsandboxed)", () => {
	withEnv({ TORUS_AUTOMODE_PROFILE: "ci" }, () => {
		const { pi, calls } = recordingPi();
		monitor.registerMonitor(pi);
		assert.deepEqual(calls.registerTool, []);
		assert.deepEqual(calls.on, []);
	});
});

test("registration: without the profile all four monitor tools register", () => {
	withEnv({ TORUS_AUTOMODE_PROFILE: undefined }, () => {
		const { pi, calls } = recordingPi();
		monitor.registerMonitor(pi);
		assert.deepEqual(calls.registerTool, [
			"torus_monitor",
			"torus_monitor_stop",
			"torus_bg",
			"torus_bg_stop",
		]);
		assert.deepEqual(calls.on, ["session_shutdown"]);
	});
});

test("TORUS_MONITOR=0 disables torus_monitor at execute time", async () => {
	const tools = [];
	monitor.registerMonitor({ registerTool: (tool) => tools.push(tool), on: () => {} });
	const monitorTool = tools.find((t) => t.name === "torus_monitor");
	assert.ok(monitorTool);

	await withEnv({ TORUS_MONITOR: "0" }, async () => {
		const result = await monitorTool.execute("call", {
			name: "off-probe",
			command: "echo never",
		});
		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, "monitors disabled (TORUS_MONITOR=0)");
	});
});

test("TORUS_BG=0 disables torus_bg at execute time", async () => {
	const tools = [];
	monitor.registerMonitor({ registerTool: (tool) => tools.push(tool), on: () => {} });
	const bgTool = tools.find((t) => t.name === "torus_bg");
	assert.ok(bgTool);

	await withEnv({ TORUS_BG: "0" }, async () => {
		const result = await bgTool.execute("call", {
			name: "off-bg",
			command: "echo never",
		});
		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, "background tasks disabled (TORUS_BG=0)");
	});
});

test("stopOn change: first check records the hash, changed output fires torus.monitor-fired", async () => {
	const customs = captureCustoms();
	const entry = fakeEntry({ name: "ci-probe" });

	await monitor.runMonitorCheck(entry);
	assert.deepEqual(customs, [], "first check only records the baseline hash");

	entry.command = "echo two";
	await monitor.runMonitorCheck(entry);

	assert.equal(customs.length, 1);
	const { message: fired, options } = customs[0];
	assert.equal(fired.customType, "torus.monitor-fired");
	assert.equal(fired.display, true);
	assert.deepEqual(fired.details, {
		name: "ci-probe",
		reason: "change",
		exit: 0,
		tail: "two",
		output: "two\n",
	});
	assert.match(fired.content[0].text, /monitor "ci-probe" output changed \(exit 0\)/);
	assert.match(fired.content[0].text, /two/, "output tail must ride along");
	assert.deepEqual(
		options,
		{ triggerTurn: true, deliverAs: "followUp" },
		"fired monitor must wake the model without steering a running turn",
	);
});

test("stopOn fail: non-zero exit fires torus.monitor-fired on the first check", async () => {
	const customs = captureCustoms();
	const entry = fakeEntry({ name: "fail-probe", command: "echo oops; exit 3", stopOn: "fail" });

	await monitor.runMonitorCheck(entry);

	assert.equal(customs.length, 1);
	const fired = customs[0].message;
	assert.equal(fired.customType, "torus.monitor-fired");
	assert.deepEqual(fired.details, {
		name: "fail-probe",
		reason: "fail",
		exit: 3,
		tail: "oops",
		output: "oops\n",
	});
	assert.match(fired.content[0].text, /monitor "fail-probe" failed \(exit 3\)/);
	assert.match(fired.content[0].text, /oops/);
});

test("stopOn fail: a long output tail truncates forward and is marked", async () => {
	const customs = captureCustoms();
	const entry = fakeEntry({
		name: "long-fail-probe",
		command: `echo start-marker ${"x".repeat(400)} end-marker; exit 3`,
		stopOn: "fail",
	});

	await monitor.runMonitorCheck(entry);

	assert.equal(customs.length, 1);
	const fired = customs[0].message;
	assert.match(fired.content[0].text, /: start-marker/);
	assert.ok(!fired.content[0].text.includes("end-marker"), "keeps the start, not the end");
	assert.ok(fired.details.tail.endsWith("…"), "a cut tail is marked as truncated");
});

test("torus_monitor tool fires the transcript marker on its immediate first check", async () => {
	const customs = captureCustoms();
	const tools = [];
	monitor.registerMonitor({ registerTool: (tool) => tools.push(tool), on: () => {} });
	const monitorTool = tools.find((t) => t.name === "torus_monitor");
	assert.ok(monitorTool, "torus_monitor not registered");

	const result = await monitorTool.execute("call", {
		name: "boom-probe",
		command: "echo bad; exit 9",
		intervalSec: 5,
		stopOn: "fail",
	});
	await monitor.pendingChecks();

	assert.match(result.content[0].text, /boom-probe/);
	assert.equal(customs.length, 1, "fired monitor must land in the transcript");
	assert.deepEqual(customs[0].message.details, {
		name: "boom-probe",
		reason: "fail",
		exit: 9,
		tail: "bad",
		output: "bad\n",
	});
});

test("a busy session holds the monitor fire; agent settle delivers it once", async () => {
	gate._resetWakeGateForTesting();
	gate._setWakeGateActiveForTesting(true);
	const customs = captureCustoms();
	const entry = fakeEntry({ name: "busy-probe" });

	await monitor.runMonitorCheck(entry);
	assert.equal(customs.length, 0, "first check only records the baseline hash");
	entry.command = "echo two";
	await monitor.runMonitorCheck(entry);
	assert.equal(customs.length, 0, "the fire must not queue as a pi follow-up while the agent runs");

	gate.wakeGateAgentSettled();
	assert.equal(customs.length, 1, "settle delivers the held fire exactly once");
	assert.equal(customs[0].message.customType, "torus.monitor-fired");
	assert.equal(customs[0].message.details.name, "busy-probe");
	gate._setWakeGateActiveForTesting(false);
});

test("monitor history lands under TORUS_HOME/state/--<project>--/monitors/", async () => {
	await monitor.runMonitorCheck(fakeEntry({ name: "state-probe" }));

	const logFile = path.join(
		HOME,
		"state",
		projectKey(process.cwd()),
		"monitors",
		"state-probe.log",
	);
	assert.ok(existsSync(logFile), "log must be written to the per-project state dir");
	const text = readFileSync(logFile, "utf8");
	assert.match(text, /check 1 exit=0/);
	assert.match(text, /one/, "command output must ride along");
});

test("the same monitor name in two project cwds keeps separate logs", async () => {
	const dirA = mkdtempSync(path.join(tmpdir(), "torus-monitor-collide-a-"));
	const dirB = mkdtempSync(path.join(tmpdir(), "torus-monitor-collide-b-"));
	const prev = process.cwd();
	try {
		process.chdir(dirA);
		const cwdA = process.cwd();
		await monitor.runMonitorCheck(fakeEntry({ name: "shared-probe", command: "echo A" }));
		process.chdir(dirB);
		const cwdB = process.cwd();
		await monitor.runMonitorCheck(fakeEntry({ name: "shared-probe", command: "echo B" }));

		assert.notEqual(cwdA, cwdB);
		const logA = readFileSync(
			path.join(HOME, "state", projectKey(cwdA), "monitors", "shared-probe.log"),
			"utf8",
		);
		const logB = readFileSync(
			path.join(HOME, "state", projectKey(cwdB), "monitors", "shared-probe.log"),
			"utf8",
		);
		assert.match(logA, /\nA\n/);
		assert.doesNotMatch(logA, /\nB\n/, "the other project's output must not leak in");
		assert.match(logB, /\nB\n/);
		assert.doesNotMatch(logB, /\nA\n/, "the other project's output must not leak in");
	} finally {
		process.chdir(prev);
		rmSync(dirA, { recursive: true, force: true });
		rmSync(dirB, { recursive: true, force: true });
	}
});
