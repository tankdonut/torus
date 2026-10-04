import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Monitor fires must reach the session transcript. HOME is redirected before
// the monitor import (it derives ~/.torus/monitors at module load) and
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
