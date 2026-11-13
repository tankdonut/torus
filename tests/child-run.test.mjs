import assert from "node:assert/strict";
import { test } from "node:test";

const { runChild, SIGKILL_GRACE_MS } = await import("../extensions/child-run.ts");

test("happy path: echo resolves with status 0 and untrimmed stdout", async () => {
	const run = await runChild("echo", ["hi"]);
	assert.equal(run.status, 0);
	assert.equal(run.stdout, "hi\n");
	assert.equal(run.stderr, "");
	assert.equal(run.error, undefined);
});

test("non-zero exit: status and both buffers come through", async () => {
	const run = await runChild("sh", ["-c", "echo out; echo err >&2; exit 3"]);
	assert.equal(run.status, 3);
	assert.equal(run.stdout, "out\n");
	assert.equal(run.stderr, "err\n");
});

test("timeout: a child that dies on SIGTERM resolves quickly with status null", async () => {
	const started = Date.now();
	const run = await runChild("sleep", ["10"], { timeoutMs: 200 });
	const elapsed = Date.now() - started;
	assert.equal(run.status, null);
	assert.ok(elapsed < 1500, `SIGTERM kill took ${elapsed}ms — grace should not have elapsed`);
});

test("timeout: a child that ignores SIGTERM gets SIGKILL after the grace period", async () => {
	// trap "" TERM makes the shell refuse SIGTERM; only the SIGKILL escalation
	// ends it, so the wall time proves the full ladder fired.
	const started = Date.now();
	const run = await runChild("sh", ["-c", 'trap "" TERM; sleep 30'], { timeoutMs: 150 });
	const elapsed = Date.now() - started;
	assert.equal(run.status, null);
	assert.ok(
		elapsed >= 150 + SIGKILL_GRACE_MS - 150,
		`resolved after ${elapsed}ms — SIGKILL fired too early`,
	);
	assert.ok(elapsed < 150 + SIGKILL_GRACE_MS + 2000, `resolved after ${elapsed}ms — too slow`);
});

test("timeout: resolveOnTimeout returns status null and the buffers so far", async () => {
	const started = Date.now();
	const run = await runChild("sh", ["-c", "echo partial; sleep 30"], {
		timeoutMs: 300,
		resolveOnTimeout: true,
	});
	const elapsed = Date.now() - started;
	assert.equal(run.status, null);
	assert.equal(run.stdout, "partial\n");
	assert.ok(elapsed < 1500, `resolveOnTimeout waited ${elapsed}ms for close instead of resolving`);
});

test("maxBuffer: stdout capture stops at the cap but the child still runs to close", async () => {
	const run = await runChild("sh", ["-c", "printf '%s' $(seq 1 5000)"], { maxBuffer: 100 });
	assert.equal(run.status, 0);
	assert.ok(run.stdout.length <= 100, `captured ${run.stdout.length} chars past the cap`);
});

test("error event: a missing binary resolves with status null and the message", async () => {
	const run = await runChild("torus-no-such-binary-xyz", []);
	assert.equal(run.status, null);
	assert.equal(run.stdout, "");
	assert.match(run.error, /ENOENT/);
});

test("signal: abort kills the child via the ladder and resolves with status null", async () => {
	const controller = new AbortController();
	const started = Date.now();
	const pending = runChild("sleep", ["30"], { signal: controller.signal });
	setTimeout(() => controller.abort(), 150);
	const run = await pending;
	const elapsed = Date.now() - started;
	assert.equal(run.status, null);
	assert.ok(elapsed < 4500, `abort resolution took ${elapsed}ms`);
});

test("signal: an already-aborted signal kills immediately", async () => {
	const controller = new AbortController();
	controller.abort();
	const run = await runChild("sleep", ["30"], { signal: controller.signal });
	assert.equal(run.status, null);
});
