import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
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
import { fileURLToPath } from "node:url";

// Sandbox first: TORUS_HOME derives every state path, and the fake engine
// routes engine-child spawns (the serve.test.mjs pattern). Ambient TORUS_*
// exports from the running session must not leak into the sandbox.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-auto-test-"));
delete process.env.TORUS_STATE_DIR;
delete process.env.TORUS_SCRATCH_DIR;
process.env.TORUS_HOME = HOME;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TORUS_ROOT = REPO_ROOT;

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-auto-engines-"));
const ARGS_ENGINE = path.join(ENGINE_DIR, "args-engine.sh");
writeFileSync(
	ARGS_ENGINE,
	'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TORUS_ARGS_DIR/spawn-$$.txt"\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(ARGS_ENGINE, 0o755);
const ARGS_DIR = path.join(ENGINE_DIR, "argv");
mkdirSync(ARGS_DIR, { recursive: true });
process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;
process.env.TORUS_ARGS_DIR = ARGS_DIR;

const {
	composeExecuteTask,
	composeGateTask,
	composePlanTask,
	defaultStageRunner,
	runAutoCli,
	startAuto,
	AutoRefusal,
} = await import("../extensions/auto/index.ts");
const { projectStateDir } = await import("../extensions/fsutil.ts");

after(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

function freshArgsDir() {
	rmSync(ARGS_DIR, { recursive: true, force: true });
	mkdirSync(ARGS_DIR, { recursive: true });
}

function fixtureDir(name) {
	const dir = mkdtempSync(path.join(tmpdir(), `torus-auto-${name}-`));
	mkdirSync(path.join(dir, "fixture"), { recursive: true });
	return path.join(dir, "fixture");
}

const PLAN_FILE = "/plans/2026-01-01-fake-plan.md";

/** Injected runner recording stage order; later tests override per-stage results. */
function fakeRunner(results = {}, record = []) {
	return async (stage, ctx) => {
		record.push({ stage, ctx });
		const result = results[stage];
		if (result === "hang") return new Promise(() => {});
		if (typeof result === "function") return result(ctx);
		return result ?? { ok: true };
	};
}

const BASE_OPTIONS = () => ({
	objective: "fix the flaky test",
	cwd: fixtureDir("opts"),
	stageTimeoutMs: 5_000,
});

test("stages chain plan→gate→execute→lens with the plan artifact threaded through ctx", async () => {
	const record = [];
	const planPath = path.join(path.join(HOME, "state", "x", "plans"), "2026-01-01-fake-plan.md");
	const report = await startAuto({
		...BASE_OPTIONS(),
		runStage: fakeRunner(
			{
				plan: { ok: true, artifact: planPath },
				gate: (ctx) => {
					assert.equal(ctx.planPath, planPath);
					assert.equal(ctx.planStem, "2026-01-01-fake-plan");
					return { ok: true, verdict: "PASS", artifact: `${planPath}.gate.md` };
				},
				execute: (ctx) => {
					assert.equal(ctx.planPath, planPath);
					assert.equal(ctx.planStem, "2026-01-01-fake-plan");
					return { ok: true };
				},
				lens: (ctx) => {
					assert.equal(ctx.planStem, "2026-01-01-fake-plan");
					return { ok: true, verdict: "OKAY" };
				},
			},
			record,
		),
	});
	assert.deepEqual(
		record.map((r) => r.stage),
		["plan", "gate", "execute", "lens"],
	);
	assert.equal(report.ok, true);
	assert.equal(report.exitCode, 0);
	assert.deepEqual(
		report.stages.map((s) => [s.stage, s.ok]),
		[
			["plan", true],
			["gate", true],
			["execute", true],
			["lens", true],
		],
	);
	for (const stage of report.stages) {
		assert.equal(typeof stage.durationMs, "number");
		assert.ok(stage.durationMs >= 0);
	}
});

test("GATE BLOCKED fails the stage named and stops the chain with exitCode 1", async () => {
	const record = [];
	const report = await startAuto({
		...BASE_OPTIONS(),
		runStage: fakeRunner(
			{
				plan: { ok: true, artifact: path.join(HOME, PLAN_FILE) },
				gate: { ok: false, verdict: "BLOCKED", error: "gate-blocked" },
			},
			record,
		),
	});
	assert.deepEqual(
		record.map((r) => r.stage),
		["plan", "gate"],
		"execute and lens must not run after a blocked gate",
	);
	assert.equal(report.ok, false);
	assert.equal(report.exitCode, 1);
	const gate = report.stages.find((s) => s.stage === "gate");
	assert.equal(gate.ok, false);
	assert.equal(gate.error, "gate-blocked");
	assert.equal(gate.verdict, "BLOCKED");
});

test("a hung stage fails named stage-timeout and stops the chain", async () => {
	const record = [];
	const report = await startAuto({
		...BASE_OPTIONS(),
		stageTimeoutMs: 50,
		runStage: fakeRunner({ plan: "hang" }, record),
	});
	assert.deepEqual(
		record.map((r) => r.stage),
		["plan"],
	);
	assert.equal(report.ok, false);
	assert.equal(report.exitCode, 1);
	const plan = report.stages[0];
	assert.equal(plan.ok, false);
	assert.equal(plan.error, "stage-timeout");
	assert.ok(plan.durationMs < 5_000, "timeout path must not wait the injected hang out");
});

test("missing cwd refuses named (no default)", async () => {
	await assert.rejects(
		startAuto({ objective: "x" }),
		(err) => err instanceof AutoRefusal && /--cwd is required/.test(err.message),
	);
	await assert.rejects(
		startAuto({ cwd: fixtureDir("empty"), objective: "" }),
		(err) => err instanceof AutoRefusal && /objective or --plan/.test(err.message),
	);
});

test("an objective is not required when --plan starts the chain at gate", async () => {
	const record = [];
	const planPath = path.join(HOME, PLAN_FILE);
	mkdirSync(path.dirname(planPath), { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const report = await startAuto({
		cwd: fixtureDir("planless"),
		planPath,
		runStage: fakeRunner(
			{
				gate: (ctx) => {
					assert.equal(ctx.planPath, planPath);
					return { ok: true, verdict: "PASS" };
				},
				execute: { ok: true },
				lens: { ok: true, verdict: "OKAY" },
			},
			record,
		),
	});
	assert.deepEqual(
		record.map((r) => r.stage),
		["gate", "execute", "lens"],
	);
	assert.equal(report.ok, true);
});

test("refusals name a missing or non-absolute plan file", async () => {
	await assert.rejects(
		startAuto({ ...BASE_OPTIONS(), planPath: "relative/plan.md" }),
		(err) => err instanceof AutoRefusal && /absolute/.test(err.message),
	);
	await assert.rejects(
		startAuto({ ...BASE_OPTIONS(), planPath: path.join(HOME, "nope.md") }),
		(err) => err instanceof AutoRefusal && /plan file not found/.test(err.message),
	);
});

// ---------------------------------------------------------------------------
// Default-runner legs. The gate/lens legs point TORUS_ROOT at a stub
// launcher so the root one-shot spawn contract runs against a controlled
// child; the plan leg uses the real repo launcher path with the fake engine.
// ---------------------------------------------------------------------------

/** A stub torus launcher: reacts to the prompt, writes the stage signal. */
function stubLauncher(_dir, body) {
	const stubRoot = mkdtempSync(path.join(tmpdir(), "torus-auto-stubroot-"));
	mkdirSync(path.join(stubRoot, "runtime", "bin"), { recursive: true });
	const launcher = path.join(stubRoot, "runtime", "bin", "torus.mjs");
	writeFileSync(launcher, `#!/usr/bin/env node\n${body}\n`, "utf8");
	chmodSync(launcher, 0o755);
	return { stubRoot, launcher };
}

/** Poll until the pid is gone; the pid-liveness assert for killed stubs. */
async function assertChildDead(pid) {
	assert.ok(Number.isInteger(pid) && pid > 0, "the stub must have recorded its pid");
	for (let i = 0; i < 100; i += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(false, "the one-shot child must be killed, not left running");
}

function withStubRoot(stubRoot, fn) {
	const prev = process.env.TORUS_ROOT;
	process.env.TORUS_ROOT = stubRoot;
	return Promise.resolve(fn()).finally(() => {
		if (prev === undefined) delete process.env.TORUS_ROOT;
		else process.env.TORUS_ROOT = prev;
	});
}

test("gate polls the machine signal: GATE PASS passes, GATE BLOCKED fails named", async () => {
	// A fresh fixture per case: the gate report must never leak a stale
	// verdict from the previous case into the next poll.
	const writeGate = (verdict) => `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1];
const planPath = prompt.split(/\\s+/)[1];
const stem = path.basename(planPath, ".md");
const gateDir = path.join(process.env.TORUS_STATE_DIR, "plans", "gates");
mkdirSync(gateDir, { recursive: true });
writeFileSync(path.join(gateDir, stem + ".gate.md"), ${JSON.stringify(verdict)} + "\\n");
`;
	for (const [verdict, expectedOk, expectedError] of [
		["GATE PASS", true, undefined],
		["GATE BLOCKED", false, "gate-blocked"],
	]) {
		const fixture = fixtureDir("gate");
		const stateDir = projectStateDir();
		const plansDir = path.join(stateDir, "plans");
		const planPath = path.join(plansDir, "2026-01-01-gate-plan.md");
		mkdirSync(plansDir, { recursive: true });
		writeFileSync(planPath, "# Plan\n");
		const { stubRoot } = stubLauncher(path.join(HOME, "stub"), writeGate(verdict));
		await withStubRoot(stubRoot, async () => {
			process.env.TORUS_STATE_DIR = stateDir;
			const runner = defaultStageRunner(stateDir);
			const result = await runner("gate", {
				objective: "x",
				cwd: fixture,
				invocationDir: process.cwd(),
				stateDir,
				stageTimeoutMs: 15_000,
				skills: [],
				planPath,
				planStem: "2026-01-01-gate-plan",
				abort: () => {},
			});
			assert.equal(result.ok, expectedOk, JSON.stringify(result));
			assert.equal(result.verdict, verdict === "GATE PASS" ? "PASS" : "BLOCKED");
			assert.equal(result.error, expectedError);
			assert.equal(result.artifact, path.join(plansDir, "gates", "2026-01-01-gate-plan.gate.md"));
		});
		rmSync(stubRoot, { recursive: true, force: true });
		rmSync(path.join(HOME, "state"), { recursive: true, force: true });
	}
});

test("lens accepts three typed OKAY rows and rejects a typed REJECT row", async () => {
	// A fresh fixture per case: ledger rows from the previous case must not
	// count toward the next acceptance.
	const appendRows = (rows) => `
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1];
const planPath = prompt.split(/\\s+/)[1];
const stem = path.basename(planPath, ".md");
const workDir = path.join(process.env.TORUS_STATE_DIR, "work");
mkdirSync(workDir, { recursive: true });
const ledger = path.join(workDir, stem + ".ledger.jsonl");
appendFileSync(ledger, ${JSON.stringify(rows)}.map(r => JSON.stringify(r)).join("\\n") + "\\n");
`;
	const okRows = [1, 2, 3].map((round) => ({
		event: "verified",
		verdict: "OKAY",
		lens: `lens${round}`,
		round,
	}));
	const cases = [
		[okRows, true, undefined],
		[
			{ event: "verified", verdict: "REJECT", lens: "comprehension", round: 1 },
			false,
			"lens-reject",
		],
	];
	for (const [rows, expectedOk, expectedError] of cases) {
		const fixture = fixtureDir("lens");
		const stateDir = projectStateDir();
		const plansDir = path.join(stateDir, "plans");
		const planPath = path.join(plansDir, "2026-01-01-lens-plan.md");
		mkdirSync(plansDir, { recursive: true });
		writeFileSync(planPath, "# Plan\n");
		const { stubRoot } = stubLauncher(path.join(HOME, "stub"), appendRows([rows].flat()));
		await withStubRoot(stubRoot, async () => {
			process.env.TORUS_STATE_DIR = stateDir;
			const runner = defaultStageRunner(stateDir);
			const result = await runner("lens", {
				objective: "x",
				cwd: fixture,
				invocationDir: process.cwd(),
				stateDir,
				stageTimeoutMs: 15_000,
				skills: [],
				planPath,
				planStem: "2026-01-01-lens-plan",
				abort: () => {},
			});
			assert.equal(result.ok, expectedOk, JSON.stringify(result));
			assert.equal(result.error, expectedError);
			assert.equal(result.verdict, expectedOk ? "OKAY" : "REJECT");
		});
		rmSync(stubRoot, { recursive: true, force: true });
		rmSync(path.join(HOME, "state"), { recursive: true, force: true });
	}
});

test("lens falls back to the one-shot's final VERDICT line when the ledger stays empty", async () => {
	const fixture = fixtureDir("lens-stdout");
	const stateDir = projectStateDir();
	const plansDir = path.join(stateDir, "plans");
	const planPath = path.join(plansDir, "2026-01-01-lens-plan.md");
	mkdirSync(plansDir, { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const body = `
console.log("...review prose...");
console.log("VERDICT: OKAY");
`;
	const { stubRoot } = stubLauncher(path.join(HOME, "stub"), body);
	await withStubRoot(stubRoot, async () => {
		process.env.TORUS_STATE_DIR = stateDir;
		const runner = defaultStageRunner(stateDir);
		const result = await runner("lens", {
			objective: "x",
			cwd: fixture,
			invocationDir: process.cwd(),
			stateDir,
			stageTimeoutMs: 15_000,
			skills: [],
			planPath,
			planStem: "2026-01-01-lens-plan",
			abort: () => {},
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.verdict, "OKAY");
	});
	rmSync(stubRoot, { recursive: true, force: true });
});

test("unknown skills fail a one-shot stage named before any spawn", async () => {
	// resolveSkillPaths refuses an unknown name driver-side, before the
	// launcher child is ever spawned: the argv dump must stay empty.
	freshArgsDir();
	const fixture = fixtureDir("skills");
	const stateDir = projectStateDir();
	const runner = defaultStageRunner(stateDir);
	const result = await runner("gate", {
		objective: "x",
		cwd: fixture,
		invocationDir: process.cwd(),
		stateDir,
		stageTimeoutMs: 5_000,
		skills: ["no-such-skill"],
		planPath: path.join(stateDir, "plans", "2026-01-01-skill-plan.md"),
		planStem: "2026-01-01-skill-plan",
		abort: () => {},
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /unknown-skill/);
	assert.equal(
		readdirSync(ARGS_DIR).length,
		0,
		"the refusal must happen before any engine spawn (empty argv dump)",
	);
});

// Contract: the plan task text carries the ABSOLUTE driver-state plans
// path (the file the driver polls), never a $TORUS_STATE_DIR literal — a
// literal would make the child resolve its own (re-pinned) state root and
// write the plan where the driver never looks.
test("the plan task names the absolute driver-state plans path, not a $TORUS_STATE_DIR literal", () => {
	const stateDir = projectStateDir();
	const task = composePlanTask("fix the flaky test", stateDir, "");
	assert.ok(
		task.includes(`${path.join(stateDir, "plans")}/<yyyy-mm-dd>-<slug>.md`),
		`task must carry the absolute plans path: ${task}`,
	);
	assert.doesNotMatch(task, /\$TORUS_STATE_DIR/);
});

// Contract: the gate prompt bounds the conductor to unattended operation
// (no user to answer questions) and names the ABSOLUTE gate report path —
// the file the driver polls — never a $TORUS_STATE_DIR literal.
test("the gate prompt carries the no-questions directive and the absolute gate-report path", () => {
	const stateDir = projectStateDir();
	const planPath = path.join(stateDir, "plans", "2026-01-01-gate-plan.md");
	const prompt = composeGateTask(planPath, stateDir);
	assert.match(prompt, /UNATTENDED one-shot run: there is no user to answer questions/);
	assert.ok(
		prompt.includes(
			path.join(stateDir, "plans", "gates", "2026-01-01-gate-plan.gate.md") + " (absolute path)",
		),
		`prompt must carry the absolute gate-report path: ${prompt}`,
	);
	assert.doesNotMatch(prompt, /\$TORUS_STATE_DIR/);
});

// Contract: the execute task is bind-FIRST — the unattended driver gates the
// stage on the work state file flipping to complete, so the child's first
// action must be work_start (a model that does the plan's work without
// binding starves the poll and the stage times out), and work_complete is
// what flips the signal. The task names the ABSOLUTE plan path.
test("the execute task leads with the bind-first directive and requires work_complete", () => {
	const planPath = path.join(projectStateDir(), "plans", "2026-01-01-execute-plan.md");
	const task = composeExecuteTask(planPath);
	assert.match(task, /Your FIRST tool action MUST be work_start\(/);
	assert.ok(task.includes(planPath), `task must carry the absolute plan path: ${task}`);
	assert.match(task, /Do not read, verify, or implement anything before work_start succeeds/);
	assert.match(task, /call work_complete/);
	assert.match(task, /the stage is not done until it succeeds/);
});

// Integration leg: one real delegation end-to-end through runDelegation with
// the fake engine (it records argv and settles immediately) and the driver's
// plan-artifact poll. Honest shortcut documented: the plan file is planted by
// the test after the engine spawn is observed — a real plan child would write
// it from the directive task; this leg proves the delegation + poll wiring,
// the unit tests above prove the stage logic.
test("plan stage drives a real delegation and polls for the new plan artifact", async () => {
	freshArgsDir();
	const fixture = fixtureDir("plan");
	const stateDir = projectStateDir();
	process.env.TORUS_STATE_DIR = stateDir;
	const plansDir = path.join(stateDir, "plans");
	mkdirSync(plansDir, { recursive: true });
	const runner = defaultStageRunner(stateDir);
	const ctx = {
		objective: "document the fixture file's purpose",
		cwd: fixture,
		invocationDir: process.cwd(),
		stateDir,
		stageTimeoutMs: 30_000,
		skills: [],
		planStem: "",
		abort: () => {},
	};
	const pending = runner("plan", ctx);
	// Wait for the engine spawn, then plant the plan file as the artifact.
	let spawned = false;
	for (let i = 0; i < 500 && !spawned; i += 1) {
		spawned = readdirSync(ARGS_DIR).length > 0;
		if (!spawned) await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(spawned, "fake engine must have been spawned");
	await new Promise((resolve) => setTimeout(resolve, 50));
	const planFile = path.join(plansDir, "2026-01-01-fixture-plan.md");
	writeFileSync(planFile, "# Plan — fixture\n");
	const result = await pending;
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.artifact, planFile);
	// The rpc attempt dies on the fake engine and the JSON fallback spawns
	// again; every argv dump combined must show the json-mode one-shot with
	// the composed directive task reaching the engine.
	const argvDumps = readdirSync(ARGS_DIR).map((f) => readFileSync(path.join(ARGS_DIR, f), "utf8"));
	const joined = argvDumps.join("\n");
	assert.match(joined, /--mode\njson/);
	assert.match(joined, /torus-plan\/SKILL\.md/);
	assert.match(joined, /planning only/);
	assert.doesNotMatch(joined, /Task: \/skill:/);
	// The composed task must name the ABSOLUTE driver-state plans path, so
	// the child writes the exact file the driver polls regardless of its
	// own environment — never a $TORUS_STATE_DIR literal.
	assert.ok(
		joined.includes(path.join(plansDir, "<yyyy-mm-dd>-<slug>.md")),
		`task must carry the absolute plans path under ${plansDir}`,
	);
	assert.doesNotMatch(joined, /\$TORUS_STATE_DIR\/plans/);
	assert.match(
		joined,
		/--append-system-prompt\n\/tmp\/torus-builder-/,
		"the child runs the builder agent's system prompt",
	);
});

// Failure leg: the delegation settles ok but no plan file ever appears —
// the stage must fail named as soon as the settle grace expires, not spin
// silently to the stage timeout.
test("a settled delegation without a plan artifact fails named before the stage timeout", async () => {
	freshArgsDir();
	const fixture = fixtureDir("plan-missing");
	const stateDir = projectStateDir();
	process.env.TORUS_STATE_DIR = stateDir;
	mkdirSync(path.join(stateDir, "plans"), { recursive: true });
	const runner = defaultStageRunner(stateDir);
	const ctx = {
		objective: "document the fixture file's purpose",
		cwd: fixture,
		invocationDir: process.cwd(),
		stateDir,
		stageTimeoutMs: 60_000,
		skills: [],
		planStem: "",
		abort: () => {},
	};
	const started = Date.now();
	const result = await runner("plan", ctx);
	const durationMs = Date.now() - started;
	assert.equal(result.ok, false);
	assert.equal(result.error, "plan-artifact-missing");
	assert.ok(
		durationMs < 45_000,
		`settled-without-artifact must fail well under the 60s timeout, took ${durationMs}ms`,
	);
});

test("runAutoCli refuses parse errors with exit 2 (unknown flag, missing value, bad timeout)", async () => {
	// Parse refusals must take the same exit-2 path as startup refusals,
	// not escape runAutoCli and exit 1 from the launcher's catch.
	assert.equal(await runAutoCli(["objective", "--bogus"]), 2);
	assert.equal(await runAutoCli(["objective", "--cwd"]), 2);
	assert.equal(
		await runAutoCli(["objective", "--cwd", fixtureDir("cli-refusal"), "--stage-timeout-ms", "0"]),
		2,
	);
});

test("the launcher exits 2 on a parse refusal", () => {
	const run = spawnSync(
		process.execPath,
		[path.join(REPO_ROOT, "runtime", "bin", "torus.mjs"), "auto", "objective", "--bogus"],
		{ encoding: "utf8", env: { ...process.env, TORUS_ROOT: REPO_ROOT } },
	);
	assert.equal(run.status, 2, `stdout=${run.stdout} stderr=${run.stderr}`);
	assert.match(run.stderr, /unknown flag: --bogus/);
});

test("runAutoCli refuses a missing --cwd with exit 2 and names the flag", async () => {
	const code = await runAutoCli(["just an objective"]);
	assert.equal(code, 2);
});

test("a stale gate report is ignored: the poll waits for the fresh verdict", async () => {
	// The previous run's verdict sits in the gate file before the stage
	// starts; the stub writes its FRESH report only after a tick. The
	// poll must refuse the stale mtime and accept the fresh write.
	const fixture = fixtureDir("gate-stale-fresh");
	const stateDir = projectStateDir();
	const plansDir = path.join(stateDir, "plans");
	const planPath = path.join(plansDir, "2026-01-01-stale-plan.md");
	mkdirSync(plansDir, { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const gateFile = path.join(plansDir, "gates", "2026-01-01-stale-plan.gate.md");
	mkdirSync(path.dirname(gateFile), { recursive: true });
	writeFileSync(gateFile, "GATE BLOCKED\n");
	const body = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.length - 1];
const planPath = prompt.split(/\\s+/)[1];
const stem = path.basename(planPath, ".md");
const gateDir = path.join(process.env.TORUS_STATE_DIR, "plans", "gates");
mkdirSync(gateDir, { recursive: true });
await new Promise((resolve) => setTimeout(resolve, 400));
writeFileSync(path.join(gateDir, stem + ".gate.md"), "GATE PASS\\n");
`;
	const { stubRoot } = stubLauncher(path.join(HOME, "stub"), body);
	await withStubRoot(stubRoot, async () => {
		process.env.TORUS_STATE_DIR = stateDir;
		const runner = defaultStageRunner(stateDir);
		const result = await runner("gate", {
			objective: "x",
			cwd: fixture,
			invocationDir: process.cwd(),
			stateDir,
			stageTimeoutMs: 10_000,
			skills: [],
			planPath,
			planStem: "2026-01-01-stale-plan",
			abort: () => {},
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.verdict, "PASS", "the fresh verdict must win over the stale one");
	});
	rmSync(stubRoot, { recursive: true, force: true });
	rmSync(path.join(HOME, "state"), { recursive: true, force: true });
});

test("a never-refreshing stale gate report times out named and kills the one-shot child", async () => {
	const fixture = fixtureDir("gate-stale-dead");
	const stateDir = projectStateDir();
	const plansDir = path.join(stateDir, "plans");
	const planPath = path.join(plansDir, "2026-01-01-stale-plan.md");
	mkdirSync(plansDir, { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const gateFile = path.join(plansDir, "gates", "2026-01-01-stale-plan.gate.md");
	mkdirSync(path.dirname(gateFile), { recursive: true });
	writeFileSync(gateFile, "GATE PASS\n");
	// The child records its pid and never writes anything: the stage must
	// fail named on the body-side deadline AND kill the child (no orphan).
	const body = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const pidDir = process.env.TORUS_STATE_DIR;
mkdirSync(pidDir, { recursive: true });
writeFileSync(path.join(pidDir, "stub-pid.txt"), String(process.pid));
setInterval(() => {}, 1_000);
`;
	const { stubRoot } = stubLauncher(path.join(HOME, "stub"), body);
	await withStubRoot(stubRoot, async () => {
		process.env.TORUS_STATE_DIR = stateDir;
		const runner = defaultStageRunner(stateDir);
		const result = await runner("gate", {
			objective: "x",
			cwd: fixture,
			invocationDir: process.cwd(),
			stateDir,
			stageTimeoutMs: 800,
			skills: [],
			planPath,
			planStem: "2026-01-01-stale-plan",
			abort: () => {},
		});
		assert.equal(result.ok, false, JSON.stringify(result));
		assert.equal(result.error, "stage-timeout");
		const pid = Number(readFileSync(path.join(stateDir, "stub-pid.txt"), "utf8").trim());
		assert.ok(Number.isInteger(pid) && pid > 0, "the stub must have recorded its pid");
		let dead = false;
		for (let i = 0; i < 100 && !dead; i += 1) {
			try {
				process.kill(pid, 0);
			} catch {
				dead = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(dead, "the one-shot child must be killed, not left running");
	});
	rmSync(stubRoot, { recursive: true, force: true });
	rmSync(path.join(HOME, "state"), { recursive: true, force: true });
});

test("gate kills the one-shot on the first fresh verdict: an intermediate BLOCKED report must not be overwritten by a live child", async () => {
	// The empirical race: the conductor writes an INTERMEDIATE report
	// (GATE BLOCKED), the poll resolves the stage on it, and the still-
	// running convergence loop later overwrites the report with a
	// different verdict. The stage must kill the child when it resolves,
	// so the on-disk artifact stays coherent with the recorded outcome.
	const fixture = fixtureDir("gate-intermediate");
	const stateDir = projectStateDir();
	const plansDir = path.join(stateDir, "plans");
	const planPath = path.join(plansDir, "2026-01-01-inter-plan.md");
	mkdirSync(plansDir, { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const body = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const stateDir = process.env.TORUS_STATE_DIR;
mkdirSync(stateDir, { recursive: true });
writeFileSync(path.join(stateDir, "stub-pid.txt"), String(process.pid));
const prompt = process.argv[process.argv.length - 1];
const planPath = prompt.split(/\\s+/)[1];
const stem = path.basename(planPath, ".md");
const gateDir = path.join(stateDir, "plans", "gates");
mkdirSync(gateDir, { recursive: true });
const gateFile = path.join(gateDir, stem + ".gate.md");
writeFileSync(gateFile, "GATE BLOCKED\\n");
setTimeout(() => { writeFileSync(gateFile, "GATE PASS\\n"); }, 2_000);
setInterval(() => {}, 1_000);
`;
	const { stubRoot } = stubLauncher(path.join(HOME, "stub"), body);
	await withStubRoot(stubRoot, async () => {
		process.env.TORUS_STATE_DIR = stateDir;
		const runner = defaultStageRunner(stateDir);
		const result = await runner("gate", {
			objective: "x",
			cwd: fixture,
			invocationDir: process.cwd(),
			stateDir,
			stageTimeoutMs: 10_000,
			skills: [],
			planPath,
			planStem: "2026-01-01-inter-plan",
			abort: () => {},
		});
		assert.equal(result.ok, false, JSON.stringify(result));
		assert.equal(result.error, "gate-blocked");
		assert.equal(result.verdict, "BLOCKED");
		const pid = Number(readFileSync(path.join(stateDir, "stub-pid.txt"), "utf8").trim());
		await assertChildDead(pid);
		const onDisk = readFileSync(
			path.join(plansDir, "gates", "2026-01-01-inter-plan.gate.md"),
			"utf8",
		);
		assert.ok(onDisk.includes("GATE BLOCKED"), "the recorded verdict must stay on disk");
		assert.ok(!onDisk.includes("GATE PASS"), "a dead child must not overwrite the report");
	});
	rmSync(stubRoot, { recursive: true, force: true });
	rmSync(path.join(HOME, "state"), { recursive: true, force: true });
});

test("lens kills the one-shot on the first fresh verdict: no rows land after the stage resolves", async () => {
	// Same-shape race for the lens poll: three OKAY rows resolve the stage;
	// a still-running child appending a later REJECT row would contradict
	// the recorded outcome. The kill must prevent it.
	const fixture = fixtureDir("lens-intermediate");
	const stateDir = projectStateDir();
	const plansDir = path.join(stateDir, "plans");
	const planPath = path.join(plansDir, "2026-01-01-inter-lens.md");
	mkdirSync(plansDir, { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const body = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const stateDir = process.env.TORUS_STATE_DIR;
mkdirSync(stateDir, { recursive: true });
writeFileSync(path.join(stateDir, "stub-pid.txt"), String(process.pid));
const prompt = process.argv[process.argv.length - 1];
const planPath = prompt.split(/\\s+/)[1];
const stem = path.basename(planPath, ".md");
const workDir = path.join(stateDir, "work");
mkdirSync(workDir, { recursive: true });
const ledger = path.join(workDir, stem + ".ledger.jsonl");
const okay = (round) => JSON.stringify({ event: "verified", verdict: "OKAY", lens: "l" + round, round });
appendFileSync(ledger, [1, 2, 3].map(okay).join("\\n") + "\\n");
setTimeout(() => {
	appendFileSync(ledger, JSON.stringify({ event: "verified", verdict: "REJECT", lens: "late", round: 4 }) + "\\n");
}, 2_000);
setInterval(() => {}, 1_000);
`;
	const { stubRoot } = stubLauncher(path.join(HOME, "stub"), body);
	await withStubRoot(stubRoot, async () => {
		process.env.TORUS_STATE_DIR = stateDir;
		const runner = defaultStageRunner(stateDir);
		const result = await runner("lens", {
			objective: "x",
			cwd: fixture,
			invocationDir: process.cwd(),
			stateDir,
			stageTimeoutMs: 10_000,
			skills: [],
			planPath,
			planStem: "2026-01-01-inter-lens",
			abort: () => {},
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.verdict, "OKAY");
		const pid = Number(readFileSync(path.join(stateDir, "stub-pid.txt"), "utf8").trim());
		await assertChildDead(pid);
		const ledgerText = readFileSync(
			path.join(stateDir, "work", "2026-01-01-inter-lens.ledger.jsonl"),
			"utf8",
		);
		assert.ok(!ledgerText.includes("REJECT"), "a dead child must not append rows after resolution");
	});
	rmSync(stubRoot, { recursive: true, force: true });
	rmSync(path.join(HOME, "state"), { recursive: true, force: true });
});

test("torus auto --help prints usage without touching the engine", () => {
	const run = spawnSync(
		process.execPath,
		[path.join(REPO_ROOT, "runtime", "bin", "torus.mjs"), "auto", "--help"],
		{ encoding: "utf8", env: { ...process.env, TORUS_ROOT: REPO_ROOT } },
	);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /torus auto - unattended plan/);
	assert.match(run.stdout, /--cwd is REQUIRED/);
});

// Contract: the gate and lens one-shot children spawn in the driver's
// invocation directory — a session's project anchor is its cwd, so the
// children must anchor to the project their coordination artifacts live
// in (spawned in the driven cwd instead, the foreign-state-key guard
// blocks the gate report and it lands where the driver never polls).
// The stub records its cwd on every spawn; both stages must record the
// test process's cwd, never the fixture.
test("gate and lens one-shots spawn in the driver's invocation directory, not the driven cwd", async () => {
	const fixture = fixtureDir("one-shot-anchor");
	const stateDir = projectStateDir();
	const plansDir = path.join(stateDir, "plans");
	const planPath = path.join(plansDir, "2026-01-01-anchor-plan.md");
	mkdirSync(plansDir, { recursive: true });
	writeFileSync(planPath, "# Plan\n");
	const body = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.join(process.env.TORUS_STATE_DIR, "cwd-records");
mkdirSync(dir, { recursive: true });
appendFileSync(path.join(dir, "cwd.txt"), process.cwd() + "\\n");
const prompt = process.argv[process.argv.length - 1];
if (prompt.includes("torus-plan-review")) {
	const planPath = prompt.split(/\\s+/)[1];
	const stem = path.basename(planPath, ".md");
	const gateDir = path.join(process.env.TORUS_STATE_DIR, "plans", "gates");
	mkdirSync(gateDir, { recursive: true });
	writeFileSync(path.join(gateDir, stem + ".gate.md"), "GATE PASS\\n");
} else {
	console.log("VERDICT: OKAY");
}
`;
	const { stubRoot } = stubLauncher(path.join(HOME, "stub"), body);
	await withStubRoot(stubRoot, async () => {
		process.env.TORUS_STATE_DIR = stateDir;
		const runner = defaultStageRunner(stateDir);
		const ctx = {
			objective: "x",
			cwd: fixture,
			invocationDir: process.cwd(),
			stateDir,
			stageTimeoutMs: 15_000,
			skills: [],
			planPath,
			planStem: "2026-01-01-anchor-plan",
			abort: () => {},
		};
		const gate = await runner("gate", ctx);
		assert.equal(gate.ok, true, JSON.stringify(gate));
		const lens = await runner("lens", ctx);
		assert.equal(lens.ok, true, JSON.stringify(lens));
		const recorded = readFileSync(path.join(stateDir, "cwd-records", "cwd.txt"), "utf8")
			.trim()
			.split("\n");
		assert.equal(recorded.length, 2, "both one-shot spawns must record their cwd");
		for (const cwd of recorded) {
			assert.equal(cwd, process.cwd(), "the one-shot must anchor to the invocation directory");
			assert.notEqual(cwd, fixture, "the one-shot must not anchor to the driven cwd");
		}
	});
	rmSync(stubRoot, { recursive: true, force: true });
	rmSync(path.join(HOME, "state"), { recursive: true, force: true });
});
