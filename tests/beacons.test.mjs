import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Run-beacon scan invariants (registry.ts foreignRunningBeacons/listExternalRuns):
// id must match the filename stem, uid must be ours when tagged, foreign files
// are never rewritten (dead pids fail in memory only), and the scan is TTL-cached.
//
// The suite sandboxes ALL torus user state via TORUS_HOME before importing the
// registry, so planted beacons never appear in the real ~/.torus/runs (and
// never flash through a live fleet widget).
const HOME = mkdtempSync(path.join(tmpdir(), "torus-beacons-test-"));
process.env.TORUS_HOME = HOME;
const RUNS = path.join(HOME, "runs");
mkdirSync(RUNS, { recursive: true });
const registry = await import("../extensions/registry.ts");

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

// Scan results are TTL-cached for ~1s; tests that plant/remove beacons let it expire.
const expireCache = () => new Promise((r) => setTimeout(r, 1050));

const stamp = Date.now().toString(36);

const spawnLiveProbe = () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	return child;
};

const plant = (id, fields) =>
	writeFileSync(
		path.join(RUNS, `${id}.json`),
		JSON.stringify({
			model: "probe",
			parentSession: null,
			sessionId: null,
			startedAt: Date.now(),
			...fields,
		}),
		"utf8",
	);

const probeStates = () => {
	const seen = new Map();
	for (const run of registry.listExternalRuns()) {
		if (run.id.startsWith(`probe-${stamp}`)) seen.set(run.id, run.state);
	}
	return seen;
};

test("beacon scan trusts only id-matching, uid-owning, running foreign beacons", async () => {
	mkdirSync(RUNS, { recursive: true });
	const foreign = spawnLiveProbe();
	const pid = foreign.pid;
	const myUid = process.getuid?.();
	const good = `probe-${stamp}-good`;
	const evilStem = `probe-${stamp}-evilfile`; // filename stem differs from beacon.id (traversal shape)
	const foreignUid = `probe-${stamp}-foreignuid`;
	const mine = `probe-${stamp}-mine`;
	const finished = `probe-${stamp}-done`;
	try {
		await expireCache();
		plant(good, { id: good, agent: "probe", status: "running", pid });
		plant(evilStem, { id: "../../pwned", agent: "probe", status: "running", pid });
		plant(foreignUid, { id: foreignUid, agent: "probe", status: "running", pid, uid: 0 });
		if (typeof myUid === "number")
			plant(mine, { id: mine, agent: "probe", status: "running", pid, uid: myUid });
		plant(finished, { id: finished, agent: "probe", status: "done", pid });
		await expireCache();
		const seen = probeStates();
		assert.equal(seen.get(good), "running", "well-formed foreign beacon is listed");
		assert.ok(
			!seen.has(evilStem) && !seen.has("../../pwned"),
			"beacon whose id differs from filename stem is skipped",
		);
		assert.ok(!seen.has(foreignUid), "uid-mismatched beacon is skipped");
		if (typeof myUid === "number")
			assert.equal(seen.get(mine), "running", "own-uid-tagged beacon is accepted");
		assert.ok(!seen.has(finished), "non-running status is skipped");
		// The traversal sink stays dead: the pre-hardening scanner rewrote mismatched
		// beacons to arbitrary paths; nothing may appear outside the sandbox.
		assert.equal(existsSync(path.join(RUNS, "..", "..", "pwned.json")), false);
		assert.equal(existsSync(path.join(homedir(), "pwned.json")), false);
	} finally {
		for (const f of [good, evilStem, foreignUid, mine, finished]) {
			rmSync(path.join(RUNS, `${f}.json`), { force: true });
		}
		foreign.kill();
	}
});

test("dead-pid beacons fail in memory only — foreign files are never rewritten", async () => {
	mkdirSync(RUNS, { recursive: true });
	await expireCache(); // reached with an expired cache so the sync block below scans fresh
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const id = `probe-${stamp}-dead${attempt}`;
		const file = path.join(RUNS, `${id}.json`);
		const reaper = spawnSync("true"); // exited + reaped child = definitely dead pid
		// Tight synchronous block: plant → scan → read back with no awaits in between,
		// so only an external process (a pre-merge host) could touch the file.
		plant(id, { id, agent: "probe", status: "running", pid: reaper.pid });
		const before = readFileSync(file, "utf8");
		const seen = probeStates();
		const after = readFileSync(file, "utf8");
		if (after !== before) {
			// External interference: a pre-hardening host rewrote the dead-pid beacon.
			assert.match(
				after,
				/"failed"/,
				"file changed — if this holds across retries, a pre-merge torus host is still running",
			);
			continue; // retry with a fresh id
		}
		assert.equal(seen.get(id), "failed", "dead pid is reported failed in memory");
		return; // clean pass: OUR scanner did not rewrite the foreign file
	}
	assert.fail(
		"every attempt observed an external rewrite — a pre-merge torus host is rewriting dead-pid beacons on this machine",
	);
});

test("foreign beacons expose sessionId, model, and logFile for the fleet detail view", async () => {
	await expireCache();
	const id = `probe-${stamp}-detail`;
	const logFile = path.join(HOME, "logs", "2026-09-30T00-00-00-000Z-dreamer.log");
	const foreign = spawnLiveProbe();
	try {
		plant(id, {
			id,
			agent: "dreamer",
			status: "running",
			pid: foreign.pid,
			sessionId: "sess-42",
			model: "zai/glm-5.3-flash",
			logFile,
		});
		await expireCache();
		const run = registry.listExternalRuns().find((r) => r.id === id);
		assert.ok(run, "beacon not listed");
		assert.equal(run.sessionId, "sess-42", "sessionId must survive the beacon→ExternalRun mapping");
		assert.equal(run.model, "zai/glm-5.3-flash", "model must survive the mapping");
		assert.equal(run.logFile, logFile, "logFile must survive the mapping");
	} finally {
		rmSync(path.join(RUNS, `${id}.json`), { force: true });
		foreign.kill();
	}
});

test("external-run scan is TTL-cached to protect the 80ms render tick", async () => {
	mkdirSync(RUNS, { recursive: true });
	const foreign = spawnLiveProbe(); // alive pid: immune to pre-merge hosts' dead-pid rewrites
	const id = `probe-${stamp}-ttl`;
	const file = path.join(RUNS, `${id}.json`);
	try {
		await expireCache();
		plant(id, { id, agent: "probe", status: "running", pid: foreign.pid });
		await expireCache();
		assert.ok(probeStates().has(id), "beacon visible after a fresh scan");
		rmSync(file); // remove on disk — the unexpired cache must keep serving the old scan
		assert.ok(probeStates().has(id), "within the TTL the stale scan is served (no rescan)");
		await expireCache();
		assert.ok(!probeStates().has(id), "after the TTL the rescan drops the removed beacon");
	} finally {
		rmSync(file, { force: true });
		foreign.kill();
	}
});

test("foreign beacons are scoped to the current session", async () => {
	mkdirSync(RUNS, { recursive: true });
	const foreign = spawnLiveProbe();
	const mine = `probe-${stamp}-scoped-mine`;
	const theirs = `probe-${stamp}-scoped-theirs`;
	const sessionless = `probe-${stamp}-scoped-null`;
	try {
		await expireCache();
		plant(mine, {
			id: mine,
			agent: "probe",
			status: "running",
			pid: foreign.pid,
			parentSession: "sess-A",
		});
		plant(theirs, {
			id: theirs,
			agent: "probe",
			status: "running",
			pid: foreign.pid,
			parentSession: "sess-B",
		});
		plant(sessionless, {
			id: sessionless,
			agent: "probe",
			status: "running",
			pid: foreign.pid,
			parentSession: null,
		});
		await expireCache();
		registry.setCurrentSession("sess-A");
		const seen = probeStates();
		assert.equal(seen.get(mine), "running", "same-session beacon stays visible");
		assert.ok(!seen.has(theirs), "other-session beacon is hidden");
		assert.ok(!seen.has(sessionless), "parentless beacon is hidden while a session is active");
		registry.setCurrentSession(null);
		await expireCache();
		const unfiltered = probeStates();
		assert.ok(
			unfiltered.has(mine) && unfiltered.has(theirs),
			"null session restores the unfiltered scan",
		);
	} finally {
		registry.setCurrentSession(null);
		rmSync(path.join(RUNS, `${mine}.json`), { force: true });
		rmSync(path.join(RUNS, `${theirs}.json`), { force: true });
		rmSync(path.join(RUNS, `${sessionless}.json`), { force: true });
		foreign.kill();
	}
});
