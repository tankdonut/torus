import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The spawn layer, against a fake notify-send: HOME is redirected so the
// desktop-entry write lands in tmp, and a shim on PATH answers the --help
// capability probe, records argv, and prints a chainable id. Summaries
// containing fail-hard / say-nothing steer the shim into the two
// null-return branches. osNotify is async, so every call is awaited.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-osnotify-spawn-test-"));
process.env.HOME = HOME;

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
