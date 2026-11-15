import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Incognito mode: the launcher flag extractor, the sweep helper, the memory
// reflection gate, and the registry's finish-time sweep. The suite sandboxes
// ALL torus user state via TORUS_HOME before importing any extension, so
// sweeps never touch real user state.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-incognito-test-"));
process.env["TORUS_HOME"] = HOME;

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("extractIncognito strips the flag in both spellings from anywhere in argv", async () => {
	const { extractIncognito } = await import("../runtime/bin/incognito.mjs");
	assert.deepEqual(extractIncognito(["a", "--incognito", "b"]), {
		argv: ["a", "b"],
		sawFlag: true,
	});
	assert.deepEqual(extractIncognito(["--incognito=1", "-p"]), { argv: ["-p"], sawFlag: true });
	assert.deepEqual(extractIncognito(["-p", "task"]), { argv: ["-p", "task"], sawFlag: false });
});

test("incognitoActive reads env over argv", async () => {
	const { incognitoActive } = await import("../extensions/incognito.ts");
	process.env["TORUS_INCOGNITO"] = "1";
	assert.equal(incognitoActive(), true);
	assert.equal(incognitoActive([]), true);
	delete process.env["TORUS_INCOGNITO"];
	assert.equal(incognitoActive([]), false);
	assert.equal(incognitoActive(["--incognito"]), true);
});

test("sweep removes every derived dir and never touches child-sessions", async () => {
	const fsutil = await import("../extensions/fsutil.ts");
	const { incognitoSweep, incognitoSweepTargets, childSessionPaths } = await import(
		"../extensions/incognito.ts"
	);
	const state = fsutil.projectStateDir();
	for (const name of incognitoSweepTargets(state)) {
		mkdirSync(name, { recursive: true });
		writeFileSync(path.join(name, "trace.txt"), "activity");
	}
	const childSessions = path.join(state, "child-sessions");
	mkdirSync(childSessions, { recursive: true });
	writeFileSync(path.join(childSessions, "abc.jsonl"), "{}");

	const survivors = incognitoSweep(state);
	assert.deepEqual(survivors, []);
	for (const child of childSessionPaths(state)) {
		assert.equal(readFileSync(child, "utf8"), "{}");
	}
	assert.equal(readdirSync(state).includes("child-sessions"), true);
});

test("memory: idle reflection never reaches delegation prep in incognito mode", async () => {
	const { writeReflectState } = await import("../extensions/reflect-state.ts");
	const registry = await import("../extensions/registry.ts");
	const memory = await import("../extensions/memory/index.ts");
	registry.resetRegistryForTesting();

	// open every non-incognito gate: a settle counter past the threshold and
	// that session's own delegation log, so only the incognito check can be
	// what stops the run short of delegation prep
	process.env["TORUS_REFLECT_TURNS"] = "1";
	writeReflectState("sess-incog", { lastReflectSettles: -5, lastReflectAt: 0 });
	await registry.startDelegation("incog-log-1", "builder", "m", "sess-incog", null, process.cwd());
	assert.equal(memory._reflectionAttempts(), 0);

	process.env["TORUS_INCOGNITO"] = "1";
	await memory._runIdleReflectionForTest("sess-incog", "turns");
	assert.equal(memory._reflectionAttempts(), 0);
	delete process.env["TORUS_INCOGNITO"];
	delete process.env["TORUS_REFLECT_TURNS"];
});

test("registry: finishDelegation in incognito mode sweeps the just-closed run log", async () => {
	const registry = await import("../extensions/registry.ts");
	registry.resetRegistryForTesting();
	const record = await registry.startDelegation(
		"incog1",
		"builder",
		"m",
		"sess",
		null,
		process.cwd(),
	);
	assert.equal(existsSync(record.logFile), true);
	assert.equal(existsSync(record.logFile), true);
	process.env["TORUS_INCOGNITO"] = "1";
	await registry.finishDelegation("incog1", true, "done text", "sess");
	assert.equal(existsSync(record.logFile), false);
	delete process.env["TORUS_INCOGNITO"];
});

test("registry: a non-incognito finish keeps the log", async () => {
	const registry = await import("../extensions/registry.ts");
	registry.resetRegistryForTesting();
	const record = await registry.startDelegation(
		"plain1",
		"builder",
		"m",
		"sess",
		null,
		process.cwd(),
	);
	await registry.finishDelegation("plain1", true, "done", "sess");
	assert.equal(existsSync(record.logFile), true);
});
