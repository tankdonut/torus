import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The spawn fallback, against a fake notify-send: HOME is redirected so the
// desktop-entry write lands in tmp, a shim on PATH answers the --help
// capability probe, records argv, and prints a chainable id, and the session
// bus address points at a socket nothing serves so osnotify's transport
// disables itself and every call lands here. Summaries containing fail-hard /
// say-nothing steer the shim into the two null-return branches. osNotify is
// async, so every call is awaited.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-osnotify-spawn-test-"));
process.env.HOME = HOME;
process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/torus-test-absent-bus";

const BIN = path.join(HOME, "bin");
const CALLS = path.join(HOME, "calls");
mkdirSync(BIN, { recursive: true });
writeFileSync(
	path.join(BIN, "notify-send"),
	[
		"#!/bin/sh",
		'if [ "$1" = "--help" ]; then echo "  -p, --print-id"; exit 0; fi',
		`printf '%s\\n' "$*" >> '${CALLS}'`,
		'case "$*" in *fail-hard*) exit 1;; *say-nothing*) exit 0;; esac',
		"echo 7",
	].join("\n"),
	{ mode: 0o755 },
);
process.env.PATH = `${BIN}:${process.env.PATH}`;

const osnotify = await import("../extensions/osnotify.ts");

const TOAST = {
	summary: "torus ✓ done",
	body: "b",
	urgency: "low",
	expireMs: 6000,
	transient: true,
};

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("TORUS_NOTIFY=0 short-circuits before any spawn", async () => {
	process.env["TORUS_NOTIFY"] = "0";
	assert.equal(await osnotify.osNotify(TOAST), null);
	assert.equal(existsSync(CALLS), false);
});

test("the desktop entry carries a resolvable Exec and gets regenerated", async () => {
	process.env["TORUS_NOTIFY"] = "1";
	const entry = path.join(HOME, ".local", "share", "applications", "torus.desktop");
	mkdirSync(path.dirname(entry), { recursive: true });
	// an entry from before the Exec fix: GLib drops it, ungrouping every toast
	writeFileSync(
		entry,
		"[Desktop Entry]\nType=Application\nName=torus\nExec=torus\nNoDisplay=true\n",
	);
	await osnotify.osNotify(TOAST);
	const text = readFileSync(entry, "utf8");
	assert.ok(text.includes("Exec=/usr/bin/true"), `stale Exec survived: ${text}`);
	assert.ok(text.includes("NoDisplay=true"));
});

test("osNotify returns the printed id, forwards replace-id, ensures the desktop entry", async () => {
	process.env["TORUS_NOTIFY"] = "1";
	assert.equal(await osnotify.osNotify(TOAST, 42), 7);
	assert.ok(existsSync(path.join(HOME, ".local", "share", "applications", "torus.desktop")));
	const last = readFileSync(CALLS, "utf8").trimEnd().split("\n").at(-1);
	assert.ok(last.includes("-r 42"));
	assert.ok(last.includes("torus ✓ done"));
});

test("non-zero notify-send exit returns null", async () => {
	process.env["TORUS_NOTIFY"] = "1";
	assert.equal(await osnotify.osNotify({ ...TOAST, summary: "fail-hard" }), null);
});

test("stdout without a parseable id returns null", async () => {
	process.env["TORUS_NOTIFY"] = "1";
	assert.equal(await osnotify.osNotify({ ...TOAST, summary: "say-nothing" }), null);
});

test("a pending replaceId promise resolves before the argv is built", async () => {
	process.env["TORUS_NOTIFY"] = "1";
	// registry stores the late toast's result and passes it on unchanged;
	// the second toast must wait for it and chain -r <resolved id>.
	const late = osnotify.osNotify({ ...TOAST, summary: "torus ▶ still running" });
	const finish = osnotify.osNotify({ ...TOAST, summary: "torus ✓ chained finish" }, late);
	assert.equal(await late, 7);
	assert.equal(await finish, 7);
	const last = readFileSync(CALLS, "utf8").trimEnd().split("\n").at(-1);
	assert.ok(last.includes("-r 7"), `expected -r 7 in: ${last}`);
	assert.ok(last.includes("torus ✓ chained finish"));
});
