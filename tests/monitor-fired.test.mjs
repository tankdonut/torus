import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const registry = await import("../extensions/registry.ts");
const monitor = await import("../extensions/monitor/index.ts");

after(() => {
	registry.setCustomSender(() => {});
	rmSync(HOME, { recursive: true, force: true });
});

function captureCustoms() {
	const customs = [];
	registry.setCustomSender((message, options) => customs.push({ message, options }));
	return customs;
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
		...overrides,
	};
}

function projectKey(cwd) {
	return `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;
}

test("stopOn change: first check records the hash, changed output fires torus.monitor-fired", () => {
	const customs = captureCustoms();
	const entry = fakeEntry({ name: "ci-probe" });

	monitor.runMonitorCheck(entry);
	assert.deepEqual(customs, [], "first check only records the baseline hash");

	entry.command = "echo two";
	monitor.runMonitorCheck(entry);

	assert.equal(customs.length, 1);
	const { message: fired, options } = customs[0];
	assert.equal(fired.customType, "torus.monitor-fired");
	assert.equal(fired.display, true);
	assert.deepEqual(fired.details, { name: "ci-probe", reason: "change", exit: 0, tail: "two" });
	assert.match(fired.content[0].text, /monitor "ci-probe" output changed \(exit 0\)/);
	assert.match(fired.content[0].text, /two/, "output tail must ride along");
	assert.deepEqual(
		options,
		{ triggerTurn: true, deliverAs: "followUp" },
		"fired monitor must wake the model without steering a running turn",
	);
});

test("stopOn fail: non-zero exit fires torus.monitor-fired on the first check", () => {
	const customs = captureCustoms();
	const entry = fakeEntry({ name: "fail-probe", command: "echo oops; exit 3", stopOn: "fail" });

	monitor.runMonitorCheck(entry);

	assert.equal(customs.length, 1);
	const fired = customs[0].message;
	assert.equal(fired.customType, "torus.monitor-fired");
	assert.deepEqual(fired.details, { name: "fail-probe", reason: "fail", exit: 3, tail: "oops" });
	assert.match(fired.content[0].text, /monitor "fail-probe" failed \(exit 3\)/);
	assert.match(fired.content[0].text, /oops/);
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

	assert.match(result.content[0].text, /boom-probe/);
	assert.equal(customs.length, 1, "fired monitor must land in the transcript");
	assert.deepEqual(customs[0].message.details, {
		name: "boom-probe",
		reason: "fail",
		exit: 9,
		tail: "bad",
	});
});

test("monitor history lands under TORUS_HOME/state/--<project>--/monitors/", () => {
	monitor.runMonitorCheck(fakeEntry({ name: "state-probe" }));

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

test("a pre-existing legacy monitors log migrates into the project state dir on first write", () => {
	const legacyFile = path.join(HOME, "monitors", "migrate-probe.log");
	mkdirSync(path.dirname(legacyFile), { recursive: true });
	writeFileSync(legacyFile, "legacy history\n", "utf8");

	monitor.runMonitorCheck(fakeEntry({ name: "migrate-probe" }));

	const migrated = path.join(
		HOME,
		"state",
		projectKey(process.cwd()),
		"monitors",
		"migrate-probe.log",
	);
	assert.ok(existsSync(migrated), "legacy content must live in the project dir after first write");
	const text = readFileSync(migrated, "utf8");
	assert.match(text, /legacy history\n/, "legacy content must be preserved");
	assert.match(text, /check 1 exit=0/, "new check must append after the migrated history");
	assert.ok(!existsSync(legacyFile), "legacy file must be renamed away, not copied");
});

test("the same monitor name in two project cwds keeps separate logs", () => {
	const dirA = mkdtempSync(path.join(tmpdir(), "torus-monitor-collide-a-"));
	const dirB = mkdtempSync(path.join(tmpdir(), "torus-monitor-collide-b-"));
	const prev = process.cwd();
	try {
		process.chdir(dirA);
		const cwdA = process.cwd();
		monitor.runMonitorCheck(fakeEntry({ name: "shared-probe", command: "echo A" }));
		process.chdir(dirB);
		const cwdB = process.cwd();
		monitor.runMonitorCheck(fakeEntry({ name: "shared-probe", command: "echo B" }));

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
