import assert from "node:assert/strict";
import { test } from "node:test";

// osnotify toast composition: pure formatters, the summary/body layout, and
// the exact notify-send argv (grouping hints, transient policy, replaces-id
// chaining). Spawning is not exercised — osNotify is a thin best-effort
// spawnSync wrapper around toastArgs.
const osnotify = await import("../extensions/osnotify.ts");

const INFO = {
	agent: "explorer",
	handle: "scout",
	model: "provider/glm-4.7-flash",
	startedAt: 1_000_000,
	turns: 4,
	tokensIn: 9_000,
	tokensOut: 2_234,
	text: "\x1b[32mall clear\x1b[0m\nsecond line",
};

test("formatDuration renders humans", () => {
	assert.equal(osnotify.formatDuration(0), "0s");
	assert.equal(osnotify.formatDuration(45_000), "45s");
	assert.equal(osnotify.formatDuration(60_000), "1m");
	assert.equal(osnotify.formatDuration(134_000), "2m 14s");
	assert.equal(osnotify.formatDuration(3_780_000), "1h 03m");
	assert.equal(osnotify.formatDuration(7_200_000), "2h");
});

test("compactTokens compacts only when it saves space", () => {
	assert.equal(osnotify.compactTokens(0), "0");
	assert.equal(osnotify.compactTokens(850), "850");
	assert.equal(osnotify.compactTokens(11_234), "11.2k");
	assert.equal(osnotify.compactTokens(180_000), "180k");
	assert.equal(osnotify.compactTokens(1_500_000), "1.5M");
});

test("runLabel prefers the handle with @ prefix", () => {
	assert.equal(osnotify.runLabel("explorer", "scout"), "@scout");
	assert.equal(osnotify.runLabel("explorer", null), "explorer");
});

test("previewLine flattens ANSI and skips blank lines", () => {
	assert.equal(osnotify.previewLine("\n\n  \x1b[1mhello world\x1b[0m  \nrest"), "hello world");
	assert.equal(osnotify.previewLine("x".repeat(200)).length, 140);
	assert.ok(osnotify.previewLine("x".repeat(200)).endsWith("…"));
	assert.equal(osnotify.previewLine(""), "");
});

test("delegationToast done leads with handle, duration, preview, stats", () => {
	const toast = osnotify.delegationToast("done", INFO, 1_134_000);
	assert.equal(toast.summary, "torus ✓ @scout finished · 2m 14s");
	assert.equal(toast.body, "all clear\n4 turns · 11.2k tok · glm-4.7-flash");
	assert.equal(toast.urgency, "low");
	assert.ok(toast.expireMs > 0);
	assert.equal(toast.transient, true);
});

test("delegationToast failed is critical and persistent", () => {
	const toast = osnotify.delegationToast("failed", INFO, 1_060_000);
	assert.equal(toast.summary, "torus ✗ @scout failed · 1m");
	assert.equal(toast.urgency, "critical");
	assert.equal(toast.expireMs, 0);
	assert.equal(toast.transient, false);
});

test("delegationToast running-late announces elapsed progress", () => {
	const toast = osnotify.delegationToast("running-late", INFO, 1_045_000);
	assert.equal(toast.summary, "torus ▶ @scout still running");
	assert.equal(toast.body.split("\n")[0], "45s in · 4 turns · 11.2k tok · glm-4.7-flash");
});

test("delegationToast falls back to agent name without handle", () => {
	const toast = osnotify.delegationToast("done", { ...INFO, handle: null, text: "" }, 8_500_000);
	assert.equal(toast.summary, "torus ✓ explorer finished · 2h 05m");
	assert.ok(toast.body.startsWith("(no text output)"));
});

test("monitorToast carries exit status and output tail", () => {
	const failed = osnotify.monitorToast("failed", {
		name: "ci",
		exit: 2,
		output: "\x1b[31mFAIL\x1b[0m src/ui.ts\n  expected 1, got 2",
	});
	assert.equal(failed.summary, "torus monitor ✗ ci failed (exit 2)");
	assert.equal(failed.body, "FAIL src/ui.ts");
	assert.equal(failed.urgency, "critical");
	assert.equal(failed.expireMs, 0);
	assert.equal(failed.transient, false);

	const changed = osnotify.monitorToast("changed", { name: "build", exit: 0, output: "" });
	assert.equal(changed.summary, "torus monitor ≈ build output changed");
	assert.equal(changed.body, "(empty output)");
	assert.equal(changed.urgency, "normal");
	assert.equal(changed.transient, false);
});

test("toastArgs groups under the torus desktop entry and chains replacements", () => {
	const args = osnotify.toastArgs(osnotify.delegationToast("done", INFO, 1_134_000), 42, true);
	assert.deepEqual(args.slice(0, 8), [
		"-a",
		"torus",
		"-u",
		"low",
		"-t",
		"6000",
		"-h",
		"STRING:desktop-entry:torus",
	]);
	assert.ok(args.includes("boolean:transient:true"));
	assert.ok(args.includes("-p"));
	assert.equal(args[args.indexOf("-r") + 1], "42");
	assert.equal(args.at(-2), "torus ✓ @scout finished · 2m 14s");
	assert.equal(args.at(-1), "all clear\n4 turns · 11.2k tok · glm-4.7-flash");
});

test("toastArgs skips chaining flags without capability and keeps failures resident", () => {
	const args = osnotify.toastArgs(osnotify.delegationToast("failed", INFO, 1_060_000), 42, false);
	assert.ok(!args.includes("-p"));
	assert.ok(!args.includes("-r"));
	assert.ok(!args.includes("boolean:transient:true"));
});

test("toastArgs escapes notification markup", () => {
	const args = osnotify.toastArgs(
		{ summary: "a<b & c", body: "x>y", urgency: "low", expireMs: 1, transient: false },
		undefined,
		false,
	);
	assert.equal(args.at(-2), "a&lt;b &amp; c");
	assert.equal(args.at(-1), "x&gt;y");
});

test("toastArgs omits an empty body argument", () => {
	const args = osnotify.toastArgs(
		{ summary: "s", body: "", urgency: "low", expireMs: 1, transient: false },
		undefined,
		false,
	);
	assert.equal(args.at(-1), "s");
	assert.equal(args.length, 9);
});
