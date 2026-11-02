import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// scripts/migrate-child-sessions.mjs: child transcripts move out of pi's
// default session dir into <state>/child-sessions, keyed by session ids
// harvested from delegation/team logs. Dry-run by default; a fork (header
// parentSession) and sessions no log mentions are never moved. The script
// runs as a subprocess against fixture trees, exactly as a user invokes it.
const SCRIPT = path.resolve("scripts/migrate-child-sessions.mjs");

const CHILD_ID = "bbbbbbb1-0000-4000-8000-000000000001";
const FORK_ID = "bbbbbbb2-0000-4000-8000-000000000002";
const STRANGER_ID = "bbbbbbb3-0000-4000-8000-000000000003";

function buildFixture() {
	const home = mkdtempSync(path.join(tmpdir(), "torus-migrate-home-"));
	const agentDir = mkdtempSync(path.join(tmpdir(), "torus-migrate-agent-"));
	const stateDir = path.join(home, "state", "--fixture-project--");
	const logsDir = path.join(stateDir, "logs");
	const projectDir = path.join(agentDir, "sessions", "--fixture-project--");
	mkdirSync(logsDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	writeFileSync(
		path.join(logsDir, "2026-11-02T00-00-00-000Z-builder.log"),
		`<torus:done session="${CHILD_ID}" ts="2026-11-02T00:01:00.000Z" />\n` +
			`<torus:done session="${FORK_ID}" ts="2026-11-02T00:02:00.000Z" />\n`,
		"utf8",
	);

	const plant = (id, extra = {}) =>
		writeFileSync(
			path.join(projectDir, `2026-11-02T00-00-00-000Z_${id}.jsonl`),
			`${JSON.stringify({ type: "session", id, timestamp: "2026-11-02T00:00:00.000Z", cwd: "/fixture", ...extra })}\n`,
			"utf8",
		);
	plant(CHILD_ID);
	plant(FORK_ID, { parentSession: "/elsewhere/session.jsonl" });
	plant(STRANGER_ID);

	return { home, agentDir, stateDir, projectDir };
}

function runScript(home, agentDir, stateDir, ...extraArgs) {
	const env = { ...process.env, TORUS_HOME: home, PI_CODING_AGENT_DIR: agentDir };
	delete env.TORUS_STATE_DIR;
	return spawnSync(process.execPath, [SCRIPT, "--state", stateDir, ...extraArgs], {
		env,
		encoding: "utf8",
	});
}

test("dry run reports the move but touches nothing", () => {
	const fx = buildFixture();
	try {
		const result = runScript(fx.home, fx.agentDir, fx.stateDir);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes("would move"), result.stdout);
		assert.ok(result.stdout.includes(CHILD_ID), result.stdout);
		assert.ok(result.stdout.includes("fork"), result.stdout);
		assert.ok(existsSync(path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${CHILD_ID}.jsonl`)));
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.agentDir, { recursive: true, force: true });
	}
});

test("--apply moves the logged child, skips the fork and unlogged sessions", () => {
	const fx = buildFixture();
	try {
		const result = runScript(fx.home, fx.agentDir, fx.stateDir, "--apply");
		assert.equal(result.status, 0, result.stderr);

		const dest = path.join(
			fx.stateDir,
			"child-sessions",
			`2026-11-02T00-00-00-000Z_${CHILD_ID}.jsonl`,
		);
		assert.ok(existsSync(dest), "child transcript not moved to child-sessions");
		assert.ok(!existsSync(path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${CHILD_ID}.jsonl`)));
		assert.ok(
			existsSync(path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${FORK_ID}.jsonl`)),
			"fork moved",
		);
		assert.ok(
			existsSync(path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${STRANGER_ID}.jsonl`)),
			"unlogged session moved",
		);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.agentDir, { recursive: true, force: true });
	}
});

test("an existing destination file is never overwritten", () => {
	const fx = buildFixture();
	try {
		const destDir = path.join(fx.stateDir, "child-sessions");
		mkdirSync(destDir, { recursive: true });
		const dest = path.join(destDir, `2026-11-02T00-00-00-000Z_${CHILD_ID}.jsonl`);
		writeFileSync(dest, "already here\n", "utf8");
		const source = path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${CHILD_ID}.jsonl`);

		const result = runScript(fx.home, fx.agentDir, fx.stateDir, "--apply");
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes("skip (exists at dest)"), result.stdout);
		assert.ok(existsSync(source), "source removed despite existing destination");
		assert.equal(readFileSync(dest, "utf8"), "already here\n");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.agentDir, { recursive: true, force: true });
	}
});
