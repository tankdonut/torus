import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// scripts/migrate-child-sessions.mjs: child transcripts move out of pi's
// default session dir into <state>/child-sessions, keyed by session ids
// harvested from delegation/team logs across every state root, and (with
// --unnamed) by the fact that torus names interactive sessions but never
// children. Dry-run by default; a fork (header parentSession), anything
// modified within the hour, and named sessions are never moved. The script
// runs as a subprocess against fixture trees, exactly as a user invokes it.
const SCRIPT = path.resolve("scripts/migrate-child-sessions.mjs");

const CHILD_ID = "bbbbbbb1-0000-4000-8000-000000000001";
const FORK_ID = "bbbbbbb2-0000-4000-8000-000000000002";
const STRANGER_ID = "bbbbbbb3-0000-4000-8000-000000000003";
const NAMED_ID = "bbbbbbb4-0000-4000-8000-000000000004";
const CROSS_ID = "bbbbbbb5-0000-4000-8000-000000000005";
const RECENT_ID = "bbbbbbb6-0000-4000-8000-000000000006";

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
	// A delegation dispatched from a worktree logs under the worktree's state
	// root; its transcript lands in the main project's pi dir.
	const worktreeLogs = path.join(home, "state", "--fixture-worktree--", "logs");
	mkdirSync(worktreeLogs, { recursive: true });
	writeFileSync(
		path.join(worktreeLogs, "2026-11-02T00-00-00-000Z-explorer.log"),
		`<torus:done session="${CROSS_ID}" ts="2026-11-02T00:03:00.000Z" />\n`,
		"utf8",
	);

	const plant = (id, extra = {}, lines = []) => {
		const file = path.join(projectDir, `2026-11-02T00-00-00-000Z_${id}.jsonl`);
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", id, timestamp: "2026-11-02T00:00:00.000Z", cwd: "/fixture", ...extra })}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`,
			"utf8",
		);
		return file;
	};
	plant(CHILD_ID);
	plant(FORK_ID, { parentSession: "/elsewhere/session.jsonl" });
	plant(STRANGER_ID);
	plant(NAMED_ID, {}, [JSON.stringify({ type: "session_info", name: "interactive planning" })]);
	plant(CROSS_ID);
	const recent = plant(RECENT_ID);

	// Fixture files are born "now"; backdate everything outside the recency
	// window, leaving exactly one fresh file behind.
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	for (const file of readdirSync(projectDir)) utimesSync(path.join(projectDir, file), old, old);
	utimesSync(recent, new Date(), new Date());

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

test("--unnamed moves unnamed sessions but keeps named, recent, and fork ones", () => {
	const fx = buildFixture();
	try {
		const result = runScript(fx.home, fx.agentDir, fx.stateDir, "--apply", "--unnamed");
		assert.equal(result.status, 0, result.stderr);
		const dest = (id) =>
			path.join(fx.stateDir, "child-sessions", `2026-11-02T00-00-00-000Z_${id}.jsonl`);
		const src = (id) => path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${id}.jsonl`);
		assert.ok(existsSync(dest(STRANGER_ID)), "unnamed session not moved");
		assert.ok(!existsSync(src(STRANGER_ID)), "unnamed session still at source");
		assert.ok(existsSync(src(NAMED_ID)), "named (interactive) session moved");
		assert.ok(existsSync(src(RECENT_ID)), "recent session moved");
		assert.ok(existsSync(src(FORK_ID)), "fork moved despite parentSession");
		assert.ok(existsSync(dest(CHILD_ID)), "logged child not moved");
		assert.ok(existsSync(dest(CROSS_ID)), "cross-root logged child not moved");
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.agentDir, { recursive: true, force: true });
	}
});

test("cross-root harvest: a worktree state root's log still moves its transcript", () => {
	const fx = buildFixture();
	try {
		const result = runScript(fx.home, fx.agentDir, fx.stateDir, "--apply");
		assert.equal(result.status, 0, result.stderr);
		assert.ok(
			!existsSync(path.join(fx.projectDir, `2026-11-02T00-00-00-000Z_${CROSS_ID}.jsonl`)),
			"cross-root child not moved",
		);
		assert.ok(
			existsSync(
				path.join(fx.stateDir, "child-sessions", `2026-11-02T00-00-00-000Z_${CROSS_ID}.jsonl`),
			),
		);
	} finally {
		rmSync(fx.home, { recursive: true, force: true });
		rmSync(fx.agentDir, { recursive: true, force: true });
	}
});
