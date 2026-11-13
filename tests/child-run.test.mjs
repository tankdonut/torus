import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("timeout: resolveOnTimeout still escalates to SIGKILL so a TERM-ignoring child dies", async () => {
	// trap "" TERM refuses SIGTERM, so only the SIGKILL escalation can end
	// the child; the shell writes its pid to a file so the test can confirm
	// the process is actually gone instead of trusting the resolved promise.
	// The inner sleep outlives the assert window but not by much, so a
	// pre-fix failure cannot hang the suite on open pipes.
	const dir = await mkdtemp(path.join(os.tmpdir(), "child-run-"));
	const pidFile = path.join(dir, "pid");
	const started = Date.now();
	const run = await runChild("bash", ["-c", 'echo $$ > "$PID_FILE"; trap "" TERM; sleep 9'], {
		timeoutMs: 300,
		resolveOnTimeout: true,
		env: { ...process.env, PID_FILE: pidFile },
	});
	const elapsed = Date.now() - started;
	assert.equal(run.status, null);
	assert.ok(
		elapsed >= 300 - 150 && elapsed < 300 + 1000,
		`resolved after ${elapsed}ms — expected resolution at ~timeoutMs`,
	);
	const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
	const deadline = Date.now() + SIGKILL_GRACE_MS + 1500;
	let dead = false;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			dead = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	// bound the leak if the escalation was cancelled so a failure fails fast
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already reaped
	}
	assert.ok(
		dead,
		`child pid ${pid} still alive ${SIGKILL_GRACE_MS + 1500}ms past the timeout — SIGKILL escalation was cancelled`,
	);
});

test("maxBuffer: stdout capture stops at the cap but the child still runs to close", async () => {
	// status 0 proves the child was left alone until natural close: with
	// killOnCap this same producer would die at the cap with status null.
	const run = await runChild("sh", ["-c", "printf '%s' $(seq 1 5000)"], { maxBuffer: 100 });
	assert.equal(run.status, 0);
	assert.ok(run.stdout.length <= 100, `captured ${run.stdout.length} chars past the cap`);
});

test("killOnCap: the first stream to reach maxBuffer kills mid-stream with status null", async () => {
	// the producer saturates the 1KB cap immediately, then the child sleeps —
	// natural close would sit 5s out, so a fast resolve proves the mid-stream
	// kill fired rather than a cap-at-close resolution.
	const started = Date.now();
	const run = await runChild("bash", ["-c", 'printf "%s\\n" $(seq 1 5000); sleep 5'], {
		maxBuffer: 1024,
		killOnCap: true,
	});
	const elapsed = Date.now() - started;
	assert.equal(run.status, null);
	assert.ok(run.stdout.length <= 1024, `captured ${run.stdout.length} chars past the cap`);
	assert.ok(elapsed < 4000, `resolved after ${elapsed}ms — killOnCap waited for close`);
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
