import assert from "node:assert/strict";
import { test } from "node:test";

// osnotify toast composition: pure formatters, the summary/body layout, and
// the exact notify-send argv (grouping hints, transient policy, replaces-id
// chaining). The spawn path itself lives in osnotify-spawn.test.mjs.
const osnotify = await import("../extensions/osnotify.ts");
const themeKit = await import("../extensions/fleet/theme-kit.ts");
const text = await import("../extensions/text.ts");

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

test("formatDuration renders humans — seconds-bearing branches and whole hours pad", () => {
	assert.equal(themeKit.formatDuration(0), "0s");
	assert.equal(themeKit.formatDuration(45_000), "45s");
	assert.equal(themeKit.formatDuration(60_000), "1m 00s");
	assert.equal(themeKit.formatDuration(62_000), "1m 02s");
	assert.equal(themeKit.formatDuration(134_000), "2m 14s");
	assert.equal(themeKit.formatDuration(3_780_000), "1h 03m");
	assert.equal(themeKit.formatDuration(7_200_000), "2h 00m");
});

test("formatTokens compacts on the 180.0k scale", () => {
	assert.equal(themeKit.formatTokens(0), "0");
	assert.equal(themeKit.formatTokens(850), "850");
	assert.equal(themeKit.formatTokens(11_234), "11.2k");
	assert.equal(themeKit.formatTokens(180_000), "180.0k");
	assert.equal(themeKit.formatTokens(1_500_000), "1.5M");
});

test("runLabel prefers the handle with @ prefix", () => {
	assert.equal(osnotify.runLabel("explorer", "scout"), "@scout");
	assert.equal(osnotify.runLabel("explorer", null), "explorer");
});

test("previewLine flattens ANSI and skips blank lines", () => {
	assert.equal(text.previewLine("\n\n  \x1b[1mhello world\x1b[0m  \nrest"), "hello world");
	assert.equal(text.previewLine("x".repeat(200)).length, 140);
	assert.ok(text.previewLine("x".repeat(200)).endsWith("…"));
	assert.equal(text.previewLine(""), "");
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
	assert.equal(toast.summary, "torus ✗ @scout failed · 1m 00s");
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

test("bgToast carries outcome, duration, and escalation reason", () => {
	const done = osnotify.bgToast("done", {
		name: "image",
		exit: 0,
		output: "built in 4m",
		durationMs: 252_000,
	});
	assert.equal(done.summary, "torus bg ✓ image exited 0 in 4m 12s");
	assert.equal(done.body, "built in 4m");
	// A clean exit is banner-only: transient low/6000 so long builds do not
	// pile up in the message tray (the resident normal/8000 style was the old one).
	assert.equal(done.urgency, "low");
	assert.equal(done.expireMs, 6000);
	assert.equal(done.transient, true);

	const timedOut = osnotify.bgToast("failed", {
		name: "bake",
		exit: null,
		output: "",
		durationMs: 60_000,
		timedOut: true,
	});
	assert.equal(timedOut.summary, "torus bg ✗ bake timed out (signal)");
	assert.equal(timedOut.body, "(no output)");
	assert.equal(timedOut.urgency, "critical");
	assert.equal(timedOut.expireMs, 0);

	const stopped = osnotify.bgToast("failed", {
		name: "build",
		exit: 143,
		output: "ok",
		durationMs: 5_000,
		stopped: true,
	});
	assert.equal(stopped.summary, "torus bg ■ build stopped (exit 143)");
});

test("shutdownToast reports the team's member count and log dir", () => {
	const toast = osnotify.shutdownToast({ name: "scouts", members: 3, dir: "/tmp/team-scouts" });
	assert.equal(toast.summary, "torus team scouts shut down");
	assert.equal(toast.body, "3 member(s) stopped · logs kept at /tmp/team-scouts");
	assert.equal(toast.urgency, "normal");
	assert.equal(toast.expireMs, 6000);
	assert.equal(toast.transient, true);
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

test("wakeToast maps the event severity onto the per-kind builders", () => {
	const done = osnotify.wakeToast({
		customType: "bg-exit",
		severity: "success",
		detail: { name: "image", code: 0, durationMs: 252_000, output: "built in 4m" },
	});
	assert.deepEqual(
		done,
		osnotify.bgToast("done", {
			name: "image",
			exit: 0,
			output: "built in 4m",
			durationMs: 252_000,
			stopped: false,
			timedOut: false,
		}),
	);

	const failed = osnotify.wakeToast({
		customType: "bg-exit",
		severity: "error",
		detail: { name: "bake", code: null, durationMs: 60_000, timedOut: true, output: "" },
	});
	assert.equal(failed.summary, "torus bg ✗ bake timed out (signal)");

	const changed = osnotify.wakeToast({
		customType: "monitor-fired",
		severity: "warning",
		detail: { name: "ci", exit: 0, output: "two" },
	});
	assert.equal(changed.summary, "torus monitor ≈ ci output changed");

	const failedMonitor = osnotify.wakeToast({
		customType: "monitor-fired",
		severity: "error",
		detail: { name: "ci", exit: 3, output: "oops" },
	});
	assert.equal(failedMonitor.urgency, "critical");

	assert.equal(
		osnotify.wakeToast({ customType: "delegation-result", severity: "success", detail: {} }),
		null,
		"registry owns delegation toasts",
	);
	assert.equal(
		osnotify.wakeToast({ customType: "team-wake", severity: "info", detail: {} }),
		null,
		"team wakes are marker-only",
	);
	assert.equal(osnotify.wakeToast({ customType: "bg-exit" }), null, "no severity, no toast");
});
