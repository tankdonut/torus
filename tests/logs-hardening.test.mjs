import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// RUNS_DIR is pinned at module load, so the whole file sandboxes TORUS_HOME
// before the registry import — beacons never reach the real ~/.torus/runs.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-logs-perms-"));
process.env["TORUS_HOME"] = HOME;

const registry = await import("../extensions/registry.ts");

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const projectKeyFor = (cwd) => `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;

test("delegation log surface: project dir 0700, log file 0600, steer text redacted", () => {
	const id = `perm-${Date.now()}`;
	const record = registry.startDelegation(id, "tester", "some-model", null, null);
	const projectLogs = path.join(HOME, "state", projectKeyFor(process.cwd()), "logs");
	assert.equal(registry.logsDir(), projectLogs, "logsDir resolves into the project state dir");
	assert.equal(
		path.dirname(record.logFile),
		projectLogs,
		"log must land under state/--<project>--/logs",
	);
	assert.equal(statSync(projectLogs).mode & 0o777, 0o700, "logs dir must be owner-only");
	assert.equal(statSync(record.logFile).mode & 0o777, 0o600, "log file must be owner-only");
	assert.equal(record.project, projectKeyFor(process.cwd()), "record carries the project key");
	const beacon = JSON.parse(readFileSync(path.join(HOME, "runs", `${id}.json`), "utf8"));
	assert.equal(beacon.project, projectKeyFor(process.cwd()), "beacon carries the project key");
	registry.finishDelegation(id, true, "done");
});

test("startDelegation(cwd) writes into that project's state dir and tags record + beacon", () => {
	const otherCwd = path.join(HOME, "worktree", "other");
	const key = projectKeyFor(otherCwd);
	const id = `cwd-${Date.now()}`;
	const record = registry.startDelegation(id, "tester", "some-model", null, null, otherCwd);
	const otherLogs = path.join(HOME, "state", key, "logs");
	assert.equal(path.dirname(record.logFile), otherLogs, "explicit cwd routes the log");
	assert.equal(statSync(otherLogs).mode & 0o777, 0o700, "logs dir must be owner-only");
	assert.equal(statSync(record.logFile).mode & 0o777, 0o600, "log file must be owner-only");
	assert.equal(record.project, key);
	const beacon = JSON.parse(readFileSync(path.join(HOME, "runs", `${id}.json`), "utf8"));
	assert.equal(beacon.project, key);
	assert.equal(beacon.logFile, record.logFile);
	registry.finishDelegation(id, true, "done");
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
