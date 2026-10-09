// TORUS_STATE_DIR export + displayPath abbreviation (fsutil).
//
// TORUS_HOME is redirected before the fsutil import so the module-load
// export captures the sandbox, mirroring the monitor-fired test setup.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const HOME = mkdtempSync(path.join(tmpdir(), "torus-state-dir-env-test-"));
process.env.TORUS_HOME = HOME;

const fsutil = await import("../extensions/fsutil.ts");
const { engineChildEnv } = await import("../extensions/engine-child.ts");

const {
	TORUS_STATE_DIR_ENV,
	displayPath,
	ensureStateDirEnv,
	projectKey,
	projectStateDir,
	torusHome,
} = fsutil;

function expectedStateDir() {
	return path.join(HOME, "state", projectKey(process.cwd()));
}

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("module load exports TORUS_STATE_DIR for the sandboxed home", () => {
	assert.equal(process.env[TORUS_STATE_DIR_ENV], expectedStateDir());
});

test("ensureStateDirEnv mirrors projectStateDir() and stays fresh across calls", () => {
	const dir = ensureStateDirEnv();
	assert.equal(dir, expectedStateDir());
	assert.equal(process.env[TORUS_STATE_DIR_ENV], dir);
	assert.equal(projectStateDir(), dir);
});

test("explicit-cwd projectStateDir calls never clobber the env mirror", () => {
	process.env[TORUS_STATE_DIR_ENV] = "/sentinel/state";
	const foreign = projectStateDir("/foreign/cwd");
	assert.equal(foreign, path.join(HOME, "state", projectKey("/foreign/cwd")));
	assert.equal(process.env[TORUS_STATE_DIR_ENV], "/sentinel/state");
	assert.equal(projectStateDir(), expectedStateDir());
	assert.equal(process.env[TORUS_STATE_DIR_ENV], expectedStateDir());
});

test("displayPath abbreviates own state root, home root, and leaves the rest alone", () => {
	const state = expectedStateDir();
	assert.equal(
		displayPath(path.join(state, "work", "s.ledger.jsonl")),
		"$TORUS_STATE_DIR/work/s.ledger.jsonl",
	);
	assert.equal(displayPath(state), "$TORUS_STATE_DIR");
	// separator-safe: a sibling key sharing a prefix must not false-match the own-state branch
	const lookalike = `${state}-extra/work/x`;
	assert.ok(!displayPath(lookalike).startsWith("$TORUS_STATE_DIR"));
	assert.equal(
		displayPath(lookalike),
		`$TORUS_HOME/state/${projectKey(process.cwd())}-extra/work/x`,
	);
	// other projects' state stays home-relative
	const sibling = path.join(HOME, "state", projectKey("/other/proj"), "work", "x");
	assert.equal(displayPath(sibling), "$TORUS_HOME/state/--other-proj--/work/x");
	assert.equal(displayPath(path.join(torusHome(), "teams.json")), "$TORUS_HOME/teams.json");
	assert.equal(displayPath("/etc/hostname"), "/etc/hostname");
});

test("engine children keep the inherited value pinned; main sessions recompute over stale values", () => {
	process.env.TORUS_ENGINE_CHILD = "1";
	process.env.TORUS_STATE_DIR = "/pinned/root";
	try {
		assert.equal(projectStateDir(), "/pinned/root");
		assert.equal(ensureStateDirEnv(), "/pinned/root");
		assert.equal(displayPath("/pinned/root/work/x.jsonl"), "$TORUS_STATE_DIR/work/x.jsonl");
	} finally {
		delete process.env.TORUS_ENGINE_CHILD;
	}
	process.env.TORUS_STATE_DIR = "/stale/root";
	assert.equal(projectStateDir(), expectedStateDir());
	assert.equal(process.env.TORUS_STATE_DIR, expectedStateDir());
});

test("engine children inherit TORUS_STATE_DIR through engineChildEnv", () => {
	ensureStateDirEnv();
	const env = engineChildEnv();
	assert.equal(env[TORUS_STATE_DIR_ENV], expectedStateDir());
	assert.equal(env.TORUS_ENGINE_CHILD, "1");
});
