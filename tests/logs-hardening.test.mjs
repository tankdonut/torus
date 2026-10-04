import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const registry = await import("../extensions/registry.ts");

test("delegation log surface: dir 0700, log file 0600, steer text redacted", () => {
	const home = mkdtempSync(path.join(tmpdir(), "torus-logs-perms-"));
	const prevHome = process.env["TORUS_HOME"];
	process.env["TORUS_HOME"] = home;
	try {
		const id = `perm-${Date.now()}`;
		const record = registry.startDelegation(id, "tester", "some-model", null, null);
		assert.equal(statSync(registry.logsDir()).mode & 0o777, 0o700, "logs dir must be owner-only");
		assert.equal(statSync(record.logFile).mode & 0o777, 0o600, "log file must be owner-only");
		registry.finishDelegation(id, true, "done");
	} finally {
		process.env["TORUS_HOME"] = prevHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("steerLogLine redacts credential shapes and keeps benign prose", () => {
	const line = registry.steerLogLine(
		'curl -H "Authorization: Bearer sk-abcdefgh1234" then GITHUB_TOKEN=ghp_secret123 deploy',
		true,
		"2026-10-01T00:00:00.000Z",
	);
	assert.equal(line.includes("sk-abcdefgh1234"), false);
	assert.equal(line.includes("ghp_secret123"), false);
	assert.equal(line.includes("Authorization: Bearer [redacted]"), true);
	assert.equal(line.includes("GITHUB_TOKEN=[redacted]"), true);
	assert.ok(line.endsWith("deploy\n"), "benign prose survives");
	assert.ok(
		line.startsWith("\n[2026-10-01T00:00:00.000Z] steer: "),
		"timestamp and delivery prefix intact",
	);
});

test("steerLogLine marks no-op delivery", () => {
	const line = registry.steerLogLine("plain text", false, "2026-10-01T00:00:00.000Z");
	assert.ok(line.includes("steer (no-op): plain text"), "undelivered steers are marked");
});
