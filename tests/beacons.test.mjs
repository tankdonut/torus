import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Run-record store invariants (registry.ts readRunBeacons/foreignRunningBeacons/
// listExternalRuns/pruneRunBeacons): id must match the filename stem, uid must be
// ours when tagged, foreign files are never rewritten (dead pids fail in memory
// only), the scan is TTL-cached, identity-only files load with zeroed stats, and
// pruning is age-based for finished runs (7 days), count-capped for running ones.
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
			rmSync(file, { force: true }); // don't leak the running beacon into later tests' scans
			continue; // retry with a fresh id
		}
		assert.equal(seen.get(id), "failed", "dead pid is reported failed in memory");
		rmSync(file, { force: true });
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

test("emitTorusCustom drops the marker when the session sender ctx is stale", () => {
	// Session replacement (fork/resume/new, or print-mode teardown) invalidates
	// the registration-time ctx captured by roster's sender closure while
	// dream/reflection delegations are still in flight; the engine throws this
	// exact stale-ctx error from the dead ctx. Emission is best-effort by
	// contract (false = no marker), so the marker drops instead of killing the
	// background run that emitted it.
	const stale = new Error(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
	);
	registry.setCustomSender(() => {
		throw stale;
	});
	assert.equal(
		registry.emitTorusCustom({
			customType: "torus.delegation-start",
			content: [{ type: "text", text: "x" }],
		}),
		false,
		"a stale sender must report no marker, not throw",
	);

	// Unrelated sender failures are real bugs and keep throwing.
	registry.setCustomSender(() => {
		throw new Error("boom");
	});
	assert.throws(() =>
		registry.emitTorusCustom({ customType: "torus.delegation-start", content: [] }),
	);
	registry.setCustomSender(() => {});
});

test("identity-only beacons from older binaries load with zeroed stats", async () => {
	await expireCache();
	const id = `probe-${stamp}-legacy`;
	const foreign = spawnLiveProbe();
	try {
		plant(id, { id, agent: "probe", status: "running", pid: foreign.pid });
		await expireCache();
		const run = registry.listExternalRuns().find((r) => r.id === id);
		assert.ok(run, "identity-only beacon is listed");
		assert.equal(run.turns, 0, "absent turns load zeroed");
		assert.equal(run.tokensIn, 0, "absent tokensIn loads zeroed");
		assert.equal(run.tokensOut, 0, "absent tokensOut loads zeroed");
		assert.equal(run.cacheRead, 0, "absent cacheRead loads zeroed");
		assert.equal(run.cacheWrite, 0, "absent cacheWrite loads zeroed");
		assert.equal(run.cost, undefined, "absent cost stays absent, as fleet rendering expects");
	} finally {
		rmSync(path.join(RUNS, `${id}.json`), { force: true });
		foreign.kill();
	}
});

test("full-format beacons surface the record fields the store now carries", async () => {
	await expireCache();
	const id = `probe-${stamp}-fullrec`;
	const foreign = spawnLiveProbe();
	try {
		plant(id, {
			id,
			agent: "ember",
			status: "running",
			pid: foreign.pid,
			source: "torus-team:t-fullrec",
			label: "Ember",
			handle: "ember",
			turns: 3,
			tokensIn: 100,
			tokensOut: 200,
			cacheRead: 300,
			cacheWrite: 400,
			cost: 0.5,
			memberStatus: "idle",
			activeSeconds: 42,
			activeUpdatedAt: Date.now() - 1000,
		});
		await expireCache();
		const run = registry.listExternalRuns().find((r) => r.id === id);
		assert.ok(run, "full-format beacon is listed");
		assert.equal(
			run.source,
			"torus-team:t-fullrec",
			"disk-provided source wins over the synthetic torus-run source",
		);
		assert.equal(run.label, "Ember", "disk-provided label wins over agent-as-label");
		assert.equal(run.handle, "ember");
		assert.equal(run.memberStatus, "idle");
		assert.equal(run.activeSeconds, 42);
		assert.equal(run.turns, 3);
		assert.equal(run.tokensIn, 100);
		assert.equal(run.tokensOut, 200);
		assert.equal(run.cacheRead, 300);
		assert.equal(run.cacheWrite, 400);
		assert.equal(run.cost, 0.5);
	} finally {
		rmSync(path.join(RUNS, `${id}.json`), { force: true });
		foreign.kill();
	}
});

test("a corrupt run JSON is skipped by the scan, not fatal", async () => {
	await expireCache();
	const id = `probe-${stamp}-corrupt`;
	const file = path.join(RUNS, `${id}.json`);
	try {
		writeFileSync(file, "{not json", "utf8");
		await expireCache();
		assert.ok(!probeStates().has(id), "corrupt file yields no run");
	} finally {
		rmSync(file, { force: true });
	}
});

test("delegation beacons carry the full record: stats, text, and finish land on disk", async () => {
	mkdirSync(RUNS, { recursive: true });
	const id = `probe-${stamp}-dele`;
	try {
		const record = await registry.startDelegation(id, "probe", "m", null, null);
		assert.equal(JSON.parse(readFileSync(path.join(RUNS, `${id}.json`), "utf8")).status, "running");
		registry.updateDelegation(id, {
			text: "partial",
			turns: 2,
			usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 6, cost: 0.25 },
		});
		await registry.finishDelegation(id, true, "final");
		const onDisk = JSON.parse(readFileSync(path.join(RUNS, `${id}.json`), "utf8"));
		assert.equal(onDisk.status, "done");
		assert.equal(onDisk.agent, "probe");
		assert.equal(onDisk.model, "m");
		assert.equal(onDisk.logFile, record.logFile);
		assert.equal(onDisk.turns, 2, "turn count lands on disk");
		assert.equal(onDisk.tokensIn, 10);
		assert.equal(onDisk.tokensOut, 20);
		assert.equal(onDisk.cacheRead, 5);
		assert.equal(onDisk.cacheWrite, 6);
		assert.equal(onDisk.cost, 0.25);
		assert.equal(onDisk.text, "final", "final text lands on disk");
		assert.equal(typeof onDisk.finishedAt, "number", "finish time lands on disk");
	} finally {
		rmSync(path.join(RUNS, `${id}.json`), { force: true });
	}
});

test("prune keeps finished runs by 7-day age and caps only running ones at 200", () => {
	mkdirSync(RUNS, { recursive: true });
	const now = Date.now();
	const DAY = 24 * 60 * 60 * 1000;
	const prefix = `prune-${stamp}`;
	const finishedOld = `${prefix}-fin-old`;
	const finishedNew = `${prefix}-fin-new`;
	const running = [];
	try {
		plant(finishedOld, {
			id: finishedOld,
			agent: "probe",
			status: "done",
			pid: process.pid,
			startedAt: now - 8 * DAY,
			finishedAt: now - 8 * DAY,
		});
		plant(finishedNew, {
			id: finishedNew,
			agent: "probe",
			status: "done",
			pid: process.pid,
			startedAt: now - 2 * DAY,
			finishedAt: now - DAY,
		});
		for (let i = 0; i < 201; i += 1) {
			const id = `${prefix}-run-${String(i).padStart(3, "0")}`;
			running.push(id);
			plant(id, {
				id,
				agent: "probe",
				status: "running",
				pid: process.pid,
				startedAt: now,
			});
			// Distinct descending mtimes make the cap's oldest-first pick deterministic.
			const at = (now - (200 - i) * 1000) / 1000;
			utimesSync(path.join(RUNS, `${id}.json`), at, at);
		}
		registry.pruneRunBeacons(now);
		assert.equal(
			existsSync(path.join(RUNS, `${finishedOld}.json`)),
			false,
			"finished beacon older than 7 days is pruned",
		);
		assert.equal(
			existsSync(path.join(RUNS, `${finishedNew}.json`)),
			true,
			"finished beacon newer than 7 days survives — the cap never touches finished runs",
		);
		let kept = 0;
		for (const id of running) if (existsSync(path.join(RUNS, `${id}.json`))) kept += 1;
		assert.equal(kept, 200, "running beacons are still count-capped at 200");
		assert.equal(
			existsSync(path.join(RUNS, `${prefix}-run-000.json`)),
			false,
			"the oldest running beacon is the one capped away",
		);
	} finally {
		rmSync(path.join(RUNS, `${finishedOld}.json`), { force: true });
		rmSync(path.join(RUNS, `${finishedNew}.json`), { force: true });
		for (const id of running) rmSync(path.join(RUNS, `${id}.json`), { force: true });
	}
});

test("the zombie horizon is unchanged: dead-pid running beacons die at 10min, live ones survive", () => {
	mkdirSync(RUNS, { recursive: true });
	const now = Date.now();
	const prefix = `zomb-${stamp}`;
	const deadId = `${prefix}-dead`;
	const ownId = `${prefix}-own`;
	const reaper = spawnSync("true"); // exited + reaped child = definitely dead pid
	try {
		plant(deadId, { id: deadId, agent: "probe", status: "running", pid: reaper.pid });
		plant(ownId, { id: ownId, agent: "probe", status: "running", pid: process.pid });
		const deadFile = path.join(RUNS, `${deadId}.json`);
		const old = (now - 11 * 60 * 1000) / 1000;
		utimesSync(deadFile, old, old);
		registry.pruneRunBeacons(now);
		assert.equal(existsSync(deadFile), false, "zombie running beacon past 10min is pruned");
		assert.equal(
			existsSync(path.join(RUNS, `${ownId}.json`)),
			true,
			"this process's own running beacon is never zombie-pruned",
		);
	} finally {
		rmSync(path.join(RUNS, `${deadId}.json`), { force: true });
		rmSync(path.join(RUNS, `${ownId}.json`), { force: true });
	}
});
