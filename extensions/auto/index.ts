/**
 * Unattended stage-chain driver (`torus auto`).
 *
 * Chains plan → gate → execute → lens with per-stage timeouts and a
 * structured report. Every stage gates on a machine signal from
 * docs/machine-contracts.md — no prose parsing:
 *
 * - PLAN: a `runDelegation` child (agent `builder`, task a DIRECTIVE that
 *   orders the child to author a work plan per
 *   `<repoRoot>/skills/torus-plan/SKILL.md` — skill-command expansion does
 *   not fire inside delegation children, so a `/skill:` prefix would reach
 *   the model as literal text and the skill would never load). After the
 *   delegation settles ok, the driver polls `$TORUS_STATE_DIR/plans/` for a
 *   new `<yyyy-mm-dd>-*.md` file created after the stage started — the plan
 *   path is an output. Two failure paths, both named
 *   `plan-artifact-missing`: the stage fails as soon as the settled
 *   delegation has produced no plan file within a 30s grace (a knowable
 *   failure must not spin silently to the timeout), and the stage timeout
 *   remains the backstop for a delegation that never settles.
 * - GATE: a ROOT one-shot spawned from the driver process
 *   (`spawn(process.execPath, [torusMjs, "-a", "--mode", "json", "-p",
 *   prompt], { cwd, env: { ...process.env } })`). Root one-shots load the
 *   full package, so the gate's four-lens fanout (which needs
 *   `torus_delegate`, absent from delegation children) works; the gate
 *   skill's own convergence loop writes the report and the driver only
 *   reads: `$TORUS_STATE_DIR/plans/gates/<planStem>.gate.md` must carry
 *   `GATE PASS` (ok) or `GATE BLOCKED` (named failure). The report's mtime
 *   is snapshotted BEFORE the one-shot spawns and only a report written
 *   after that snapshot counts — the same freshness mechanism as the plan
 *   stage's set-difference listing, so re-running the chain with
 *   `--plan <path>` cannot accept the previous run's verdict.
 * - EXECUTE: a `runDelegation` child (agent `builder`) bound with
 *   `work_start(<planPath>, assumeApproved: true)` — the unattended driver
 *   is the approving authority, journaled approval:"assumed" — then polls
 *   `$TORUS_STATE_DIR/work/<slug>.json` for `"status": "complete"`.
 * - LENS: a root one-shot (`/skill:lens-review` bound to the work slug).
 *   Acceptance, exactly: poll the bound ledger
 *   `$TORUS_STATE_DIR/work/<slug>.ledger.jsonl` for rows appended after the
 *   stage started; any `verified` row with `"verdict": "REJECT"` fails the
 *   stage named; three or more `verified` rows with `"verdict": "OKAY"` and
 *   zero REJECT pass it (the simpler ≥3-OKAY acceptance — the full
 *   three-lens identity is the skill's business, not the driver's). If the
 *   one-shot exits with no ledger rows (an unbound session lands verdicts in
 *   the final answer instead), the captured stdout's last
 *   `VERDICT: OKAY|REJECT` line decides — the second signal is documented in
 *   docs/machine-contracts.md.
 *
 * torusMjsPath resolution: the launcher exports TORUS_ROOT before importing
 * this module, and repoRoot() (extensions/registry.ts) reads TORUS_ROOT
 * first — so the one-shot launcher is `path.join(repoRoot(), "runtime",
 * "bin", "torus.mjs")`. TORUS_ENGINE_BIN is the ENGINE binary (pi), not the
 * torus launcher, and is deliberately not used here; the spawned torus
 * launcher resolves the engine itself (TORUS_PI_BIN / payload pin).
 *
 * State root: everything keys on the DRIVEN project,
 * `projectStateDir(options.cwd)` — a linked worktree keys on its main
 * checkout, same as every other torus surface. The driver pins
 * TORUS_STATE_DIR and TORUS_SCRATCH_DIR into its own environment (mirroring
 * ensureStateDirEnv) before any stage fires so delegation children inherit
 * the pinned value and root one-shots recompute the same key from their
 * cwd. The module never reads TORUS_* knobs: behavior comes from options
 * only; the TORUS_AUTO_BOOTSTRAPPED re-exec marker lives in
 * runtime/bin/torus.mjs like TORUS_SERVE_BOOTSTRAPPED.
 *
 * `--cwd` is REQUIRED: without it startAuto refuses (AutoRefusal) —
 * unattended execution must never land in the live checkout by accident.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { projectStateDir, sleep, TORUS_SCRATCH_DIR_ENV, TORUS_STATE_DIR_ENV } from "../fsutil.js";
import { listDelegations, repoRoot, stopDelegation } from "../registry.js";
import { resolveSkillPaths, runDelegation } from "../roster/index.js";

export type StageKind = "plan" | "gate" | "execute" | "lens";

export interface StageResult {
	ok: boolean;
	artifact?: string;
	verdict?: string;
	error?: string;
}

export interface StageContext {
	objective: string;
	cwd: string;
	/** The driven project's state root (plans/, work/, scratch/ live here). */
	stateDir: string;
	stageTimeoutMs: number;
	skills: string[];
	/** Roadmap path for the plan stage's stamp brief (undefined = unstamped). */
	roadmapPath?: string;
	/** Absolute plan path (set after the plan stage; required from gate on). */
	planPath?: string;
	/** Work slug for the bound plan (mirrors extensions/work slugFor). */
	planStem: string;
	/**
	 * Stops the underlying work on stage timeout: delegation stages stop via
	 * the registry, one-shot stages kill the child. The default runner
	 * assigns this; injected runners may ignore it.
	 */
	abort: () => void;
}

export interface AutoOptions {
	objective: string;
	roadmapPath?: string;
	/** Pre-existing plan: skips the PLAN stage and gates on this file. */
	planPath?: string;
	/** REQUIRED — the driven checkout (worktree or scratch copy). */
	cwd: string;
	stageTimeoutMs?: number;
	skills?: string[];
	/** Injectable stage runner (tests fake stages without engines). */
	runStage?: (stage: StageKind, ctx: StageContext) => Promise<StageResult>;
}

export interface AutoReport {
	stages: Array<
		StageResult & {
			stage: StageKind;
			durationMs: number;
		}
	>;
	ok: boolean;
	exitCode: number;
}

/** Named startup refusal (missing cwd, no objective/plan, unknown plan path). */
export class AutoRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "auto-refusal";
	}
}

const DEFAULT_STAGE_TIMEOUT_MS = 600_000;
const POLL_MS = 250;
/** After a one-shot exits, keep polling this long for the signal file. */
const EXIT_GRACE_MS = 5_000;
/** After a settled plan delegation, keep polling this long for the plan file. */
const PLAN_SETTLE_GRACE_MS = 30_000;
const PLAN_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

/**
 * Work slug for a plan path: the stem restricted to a filesystem-safe
 * charset — mirrors extensions/work's slugFor so state-file polls agree with
 * what work_start binds.
 */
function workSlug(planPath: string): string {
	const slug = path
		.basename(planPath, ".md")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 120);
	return slug.length > 0 ? slug : "plan";
}

/**
 * The PLAN stage's task text. A directive, not a skill command: delegation
 * children receive the task as literal prompt text (no /skill expansion),
 * so the child is ordered to read the skill file itself and author the plan
 * artifact the driver polls for.
 */
function composePlanTask(objective: string, roadmapBrief: string): string {
	return (
		`You are authoring a work plan, not implementing. Read ` +
		`${path.join(repoRoot(), "skills", "torus-plan", "SKILL.md")} and follow ` +
		`its format exactly. Objective (the only thing the plan covers): ${objective}. ` +
		`Write the plan to the plans directory ` +
		`($TORUS_STATE_DIR/plans/<yyyy-mm-dd>-<slug>.md) with: wave headings, ` +
		`column-zero checkbox tasks each carrying Acceptance/QA/Executor details, ` +
		`a final verification wave with F-tasks, and a Stopping condition section. ` +
		`Do NOT create the Approval line (the driver approves via assumeApproved). ` +
		`Do NOT implement anything — planning only.` +
		roadmapBrief
	);
}

/** Raw plan stem (filename minus .md) — the gate report's naming key. */
function planStem(planPath: string): string {
	return path.basename(planPath, ".md");
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function readFileIfExists(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/** Read a JSONL file as parsed rows; unparseable lines are skipped. */
async function readJsonlRows(file: string): Promise<Array<Record<string, unknown>>> {
	const text = await readFileIfExists(file);
	if (text === null) return [];
	const rows: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			rows.push(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			// non-JSON lines (e.g. trailing partial writes) read as absent
		}
	}
	return rows;
}

interface OneShot {
	exited: Promise<number | null>;
	stdoutFile: string;
	stderrFile: string;
	kill: () => void;
}

/**
 * Spawn a root one-shot launcher child from the driver process. The child is
 * `node <torusMjs> -a --mode json -p <prompt>` run in the driven cwd with the
 * environment passed through as-is; stdout (JSONL) and stderr go to temp
 * files under the driver's state scratch. Env is inherited explicitly — a
 * node child spawning the launcher must propagate TORUS_ROOT and
 * TORUS_ENGINE_BIN itself, the launcher cannot re-derive them.
 */
async function spawnOneShot(
	torusMjs: string,
	prompt: string,
	ctx: StageContext,
	skillPaths: string[],
): Promise<OneShot> {
	const scratchRoot = path.join(ctx.stateDir, "scratch");
	await mkdir(scratchRoot, { recursive: true });
	const dir = await mkdtemp(path.join(scratchRoot, "auto-"));
	const stdoutFile = path.join(dir, "stdout.jsonl");
	const stderrFile = path.join(dir, "stderr.txt");
	const out = await open(stdoutFile, "w");
	const err = await open(stderrFile, "w");
	const args: string[] = ["-a", "--mode", "json", "-p"];
	for (const skillPath of skillPaths) args.push("--skill", skillPath);
	args.push(prompt);
	const child = spawn(process.execPath, [torusMjs, ...args], {
		cwd: ctx.cwd,
		env: { ...process.env },
		stdio: ["ignore", out.fd, err.fd],
	});
	out.close();
	err.close();
	let killed = false;
	const exited = new Promise<number | null>((resolve) => {
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code));
	});
	return {
		exited,
		stdoutFile,
		stderrFile,
		kill: () => {
			if (killed || child.exitCode !== null) return;
			killed = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 5_000).unref();
		},
	};
}

function resolveLauncher(): string {
	const torusMjs = path.join(repoRoot(), "runtime", "bin", "torus.mjs");
	if (!existsSync(torusMjs)) {
		throw new Error(
			`torus auto: launcher not found at ${torusMjs} — the driver must run from a torus payload (TORUS_ROOT)`,
		);
	}
	return torusMjs;
}

/** Stop the delegation this stage started, via its handle in the registry. */
function stopStageDelegation(handle: string): void {
	const record = listDelegations().find((r) => r.handle === handle && r.status === "running");
	if (record) stopDelegation(record.id);
}

/**
 * Race a stage body against its timeout. The loser keeps running (abort()
 * settles it) but its outcome is ignored. Never rejects.
 */
async function raceStage(
	body: Promise<StageResult>,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<StageResult> {
	let timer: NodeJS.Timeout | undefined;
	const fired = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	const guarded = body.then(
		(v) => ({ v }) as { v: StageResult } | { e: unknown },
		(e) => ({ e }),
	);
	const winner = await Promise.race([guarded, fired]);
	clearTimeout(timer);
	if (winner === "timeout") {
		onTimeout();
		return { ok: false, error: "stage-timeout" };
	}
	if ("e" in winner) return { ok: false, error: `stage-crashed: ${String(winner.e)}` };
	return winner.v;
}

/** Stage timeout clock: a deadline shared by settle, spawn, and polling. */
class Deadline {
	readonly at: number;
	constructor(timeoutMs: number) {
		this.at = Date.now() + timeoutMs;
	}
	left(): number {
		return Math.max(0, this.at - Date.now());
	}
	past(): boolean {
		return this.left() <= 0;
	}
}

async function runPlanDelegation(
	task: string,
	ctx: StageContext,
	handle: string,
): Promise<StageResult> {
	const outcomePromise = runDelegation(
		"builder",
		task,
		ctx.cwd,
		undefined,
		null,
		handle,
		ctx.skills.length > 0 ? ctx.skills : null,
		false,
		false,
	);
	ctx.abort = () => stopStageDelegation(handle);
	const outcome = await outcomePromise;
	if (!outcome.ok) {
		const verdict = outcome.details["verdict"] as { error?: unknown } | undefined;
		const detail = typeof verdict?.error === "string" ? ` (${verdict.error})` : "";
		return { ok: false, error: `delegation-failed${detail}: ${outcome.text.slice(0, 400)}` };
	}
	return { ok: true };
}

/**
 * Default stage runner: delegation stages (plan, execute) call
 * runDelegation; one-shot stages (gate, lens) spawn the root launcher; both
 * poll their machine signal until the stage deadline.
 */
export function defaultStageRunner(stateDir: string) {
	const torusMjs = resolveLauncher();
	return async (stage: StageKind, ctx: StageContext): Promise<StageResult> => {
		const deadline = new Deadline(ctx.stageTimeoutMs);
		const plansDir = path.join(stateDir, "plans");
		if (stage === "plan") {
			const before = new Set(await listDir(plansDir));
			const roadmapBrief =
				ctx.roadmapPath !== undefined
					? `\n\nRoadmap brief: the plan's Destination must carry a "Roadmap: ${ctx.roadmapPath} (items R…)" stamp line naming this roadmap; roadmap sync reads that stamp.`
					: "";
			const task = composePlanTask(ctx.objective.trim(), roadmapBrief);
			const settled = await raceStage(
				runPlanDelegation(task, ctx, "auto-plan"),
				deadline.left(),
				ctx.abort,
			);
			if (!settled.ok) return settled;
			// The delegation settled: the plan file, if the child wrote one,
			// lands within a short grace (writes can trail the settle by a
			// moment). Past the grace with no artifact the stage fails named
			// instead of spinning to the stage timeout; the timeout stays the
			// backstop for a delegation that never settles.
			const graceEnds = Date.now() + Math.min(PLAN_SETTLE_GRACE_MS, deadline.left());
			while (Date.now() < graceEnds) {
				const files = (await listDir(plansDir))
					.filter((f) => PLAN_FILE_PATTERN.test(f) && !before.has(f))
					.map((f) => path.join(plansDir, f))
					.sort((a, b) => a.localeCompare(b));
				const newest = files[files.length - 1];
				if (newest !== undefined) return { ok: true, artifact: newest };
				await sleep(POLL_MS);
			}
			return { ok: false, error: "plan-artifact-missing" };
		}
		if (stage === "gate") {
			if (ctx.planPath === undefined) return { ok: false, error: "gate-needs-plan" };
			const skills = resolveOneShotSkills(ctx);
			if ("error" in skills) return { ok: false, error: skills.error };
			const gateFile = path.join(plansDir, "gates", `${planStem(ctx.planPath)}.gate.md`);
			// Snapshot the report's freshness BEFORE spawning: an existing file
			// is a previous run's verdict and must never be accepted.
			const baselineMtime = await gateMtime(gateFile);
			const shot = await spawnOneShot(
				torusMjs,
				`/skill:torus-plan-review ${ctx.planPath}`,
				ctx,
				skills.paths,
			);
			ctx.abort = shot.kill;
			return pollGateReport(gateFile, baselineMtime, shot, deadline);
		}
		if (stage === "execute") {
			if (ctx.planPath === undefined) return { ok: false, error: "execute-needs-plan" };
			const task =
				`Bind and work the plan at ${ctx.planPath} to completion: use ` +
				`work_start(${ctx.planPath}, assumeApproved: true) — the approving authority is the ` +
				`unattended driver (journaled approval:"assumed") — then work every task to done ` +
				`per the plan, then work_complete.`;
			const settled = await raceStage(
				runPlanDelegation(task, ctx, "auto-execute"),
				deadline.left(),
				ctx.abort,
			);
			if (!settled.ok) return settled;
			const workFile = path.join(stateDir, "work", `${workSlug(ctx.planPath)}.json`);
			while (!deadline.past()) {
				const state = await readJsonFile(workFile);
				if (state !== null && state["status"] === "complete") {
					return { ok: true, artifact: workFile };
				}
				await sleep(POLL_MS);
			}
			return { ok: false, error: "execute-incomplete" };
		}
		// lens
		if (ctx.planPath === undefined) return { ok: false, error: "lens-needs-plan" };
		const skills = resolveOneShotSkills(ctx);
		if ("error" in skills) return { ok: false, error: skills.error };
		const ledgerFile = path.join(stateDir, "work", `${workSlug(ctx.planPath)}.ledger.jsonl`);
		const beforeRows = (await readJsonlRows(ledgerFile)).length;
		const prompt =
			`/skill:lens-review ${ctx.planPath}\n\n` +
			`This review is bound to the work slug ${workSlug(ctx.planPath)} (ledger: ` +
			`${ledgerFile}). Land one typed verified row per lens verdict via work_note, ` +
			`carrying lens, verdict, and round as typed params. If work_note is unavailable ` +
			`or no work is bound to this session, end the final answer with a single line ` +
			`"VERDICT: OKAY" or "VERDICT: REJECT".`;
		const shot = await spawnOneShot(torusMjs, prompt, ctx, skills.paths);
		ctx.abort = shot.kill;
		return pollLensVerdict(ledgerFile, beforeRows, shot, deadline);
	};
}

/**
 * Resolve the one-shot's --skill args. Delegation stages hand skills to
 * runDelegation's own validation; root one-shots need paths up front, so the
 * same resolver runs driver-side and a refusal becomes a named stage failure.
 */
function resolveOneShotSkills(ctx: StageContext): { paths: string[] } | { error: string } {
	if (ctx.skills.length === 0) return { paths: [] };
	const resolved = resolveSkillPaths(ctx.skills, ctx.cwd);
	if (resolved.rejected.length > 0) {
		return {
			error: `skill-path-outside-roots: ${resolved.rejected.map((s) => `"${s}"`).join(", ")}`,
		};
	}
	if (resolved.missing.length > 0) {
		return { error: `unknown-skill: ${resolved.missing.map((s) => `"${s}"`).join(", ")}` };
	}
	return { paths: resolved.paths };
}

/** The gate report's mtime, or 0 when absent — the freshness baseline. */
async function gateMtime(file: string): Promise<number> {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Freshness guard: read the gate report only if it is newer than the
 * pre-spawn baseline mtime (0 = the file was absent). A report whose mtime
 * is <= the baseline is a previous run's verdict and reads as no signal,
 * mirroring the plan stage's set-difference against its pre-stage listing.
 */
async function readFreshGateReport(
	gateFile: string,
	baselineMtime: number,
): Promise<StageResult | null> {
	try {
		const mtime = (await stat(gateFile)).mtimeMs;
		if (mtime <= baselineMtime) return null;
		return gateVerdict(await readFile(gateFile, "utf8"), gateFile);
	} catch {
		// vanished between stat and read (or unreadable): no signal yet
		return null;
	}
}

function gateVerdict(text: string, gateFile: string): StageResult | null {
	// Fail-safe ordering: BLOCKED wins when a report somehow carries both.
	if (text.includes("GATE BLOCKED")) {
		return { ok: false, verdict: "BLOCKED", artifact: gateFile, error: "gate-blocked" };
	}
	if (text.includes("GATE PASS")) {
		return { ok: true, verdict: "PASS", artifact: gateFile };
	}
	return null;
}

async function pollGateReport(
	gateFile: string,
	baselineMtime: number,
	shot: OneShot,
	deadline: Deadline,
): Promise<StageResult> {
	// The gate conductor writes the report just before exiting, so a read
	// racing the child's exit is normal; only a child gone with no report
	// after a grace window fails named instead of burning the stage timeout
	// on a dead child.
	let exited = false;
	void shot.exited.then(() => {
		exited = true;
	});
	for (;;) {
		const verdict = await readFreshGateReport(gateFile, baselineMtime);
		if (verdict !== null) return verdict;
		if (deadline.past()) {
			// The body can win the race against the outer timer; stop the
			// child here too so no one-shot is left running unattended.
			shot.kill();
			return { ok: false, error: "stage-timeout" };
		}
		await sleep(POLL_MS);
		if (exited) {
			const graceEnd = Date.now() + EXIT_GRACE_MS;
			while (Date.now() < graceEnd) {
				const final = await readFreshGateReport(gateFile, baselineMtime);
				if (final !== null) return final;
				await sleep(POLL_MS);
			}
			return { ok: false, error: "gate-report-missing" };
		}
	}
}

async function pollLensVerdict(
	ledgerFile: string,
	beforeRows: number,
	shot: OneShot,
	deadline: Deadline,
): Promise<StageResult> {
	const ledgerVerdict = async (): Promise<StageResult | null> => {
		const rows = (await readJsonlRows(ledgerFile)).slice(beforeRows);
		const verified = rows.filter(
			(r) => r["event"] === "verified" && typeof r["verdict"] === "string",
		);
		if (verified.some((r) => r["verdict"] === "REJECT")) {
			return { ok: false, verdict: "REJECT", artifact: ledgerFile, error: "lens-reject" };
		}
		if (verified.filter((r) => r["verdict"] === "OKAY").length >= 3) {
			return { ok: true, verdict: "OKAY", artifact: ledgerFile };
		}
		return null;
	};
	let exited = false;
	void shot.exited.then(() => {
		exited = true;
	});
	for (;;) {
		const accepted = await ledgerVerdict();
		if (accepted !== null) return accepted;
		if (deadline.past()) {
			// Same body-side race as the gate: stop the child here too.
			shot.kill();
			return { ok: false, error: "stage-timeout" };
		}
		if (exited) {
			// Child gone: one final ledger read, then the stdout VERDICT
			// fallback (an unbound session lands verdicts in its final answer).
			const late = await ledgerVerdict();
			if (late !== null) return late;
			const stdout = await readFileIfExists(shot.stdoutFile);
			const verdicts = [...(stdout ?? "").matchAll(/VERDICT:\s*(OKAY|REJECT)/g)];
			const last = verdicts[verdicts.length - 1];
			if (last?.[1] === "OKAY") {
				return { ok: true, verdict: "OKAY", artifact: shot.stdoutFile };
			}
			if (last?.[1] === "REJECT") {
				return { ok: false, verdict: "REJECT", artifact: shot.stdoutFile, error: "lens-reject" };
			}
			return { ok: false, error: "lens-verdict-missing" };
		}
		await sleep(POLL_MS);
	}
}

function refusal(message: string): never {
	throw new AutoRefusal(message);
}

/**
 * Run the stage chain sequentially: one pass, no parallel stages, stop at
 * the first failing stage. With `options.planPath` the chain starts at gate
 * (the plan already exists); otherwise plan → gate → execute → lens.
 */
export async function startAuto(options: AutoOptions): Promise<AutoReport> {
	const cwd = options.cwd;
	if (typeof cwd !== "string" || cwd.trim().length === 0) {
		refusal(
			"--cwd is required: pass the driven checkout (a worktree or scratch copy) — the driver never lands in the current directory by default",
		);
	}
	const objective = (options.objective ?? "").trim();
	const planPath = options.planPath?.trim();
	if (objective.length === 0 && planPath === undefined) {
		refusal(
			"an objective or --plan <path> is required: the plan stage composes /skill:torus-plan from the objective, or the chain gates on an existing plan",
		);
	}
	if (planPath !== undefined && !path.isAbsolute(planPath)) {
		refusal(`--plan must be an absolute path: ${planPath}`);
	}
	if (planPath !== undefined && !existsSync(planPath)) {
		refusal(`plan file not found: ${planPath}`);
	}
	const stateDir = projectStateDir(path.resolve(cwd));
	// Pin the driven project's state into the environment so delegation
	// children inherit it (engine children honor the pinned value) and root
	// one-shots recompute the same key from their cwd — one state root for
	// every stage signal.
	process.env[TORUS_STATE_DIR_ENV] = stateDir;
	process.env[TORUS_SCRATCH_DIR_ENV] = path.join(stateDir, "scratch");
	const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
	const runStage = options.runStage ?? defaultStageRunner(stateDir);
	const kinds: StageKind[] =
		planPath !== undefined ? ["gate", "execute", "lens"] : ["plan", "gate", "execute", "lens"];
	const stages: AutoReport["stages"] = [];
	let currentPlan = planPath;
	for (const stage of kinds) {
		const startedAt = Date.now();
		const ctx: StageContext = {
			objective,
			cwd: path.resolve(cwd),
			stateDir,
			stageTimeoutMs,
			skills: options.skills ?? [],
			roadmapPath: options.roadmapPath,
			planPath: currentPlan,
			planStem: currentPlan !== undefined ? planStem(currentPlan) : "",
			abort: () => {},
		};
		// The timeout wraps every stage — including injected runners (a hung
		// fake must still fail named). The default runner keeps its own deadline
		// for polling; the outer race guarantees the stop.
		let result = await raceStage((async () => runStage(stage, ctx))(), stageTimeoutMs, () =>
			ctx.abort(),
		);
		if (stage === "plan" && result.ok && result.artifact === undefined) {
			result = { ok: false, error: "plan-artifact-missing" };
		}
		stages.push({ stage, ...result, durationMs: Date.now() - startedAt });
		if (!result.ok) break;
		if (stage === "plan") currentPlan = result.artifact;
	}
	const ok = stages.every((s) => s.ok);
	return { stages, ok, exitCode: ok ? 0 : 1 };
}

function autoUsageError(message: string): never {
	throw new AutoRefusal(`${message}\n\n${AUTO_USAGE}`);
}

const AUTO_USAGE = [
	"Usage: torus auto <objective> --cwd <dir> [flags]",
	"",
	"Flags:",
	"  --roadmap <path>        stamp the plan for this roadmap (items R…)",
	"  --plan <path>           start from an existing plan (skips the plan stage)",
	"  --cwd <dir>             REQUIRED: the driven checkout",
	"  --stage-timeout-ms <n>  per-stage timeout (default 600000)",
	"  --skills <a,b>          skill names or paths passed to every stage",
].join("\n");

/** Parse the CLI surface, run the chain, and print the report. */
export async function runAutoCli(argv: string[]): Promise<number> {
	let objective = "";
	let roadmapPath: string | undefined;
	let planPath: string | undefined;
	let cwd: string | undefined;
	let stageTimeoutMs: number | undefined;
	let skills: string[] | undefined;
	const words: string[] = [];
	// The parse loop sits inside the try: autoUsageError throws AutoRefusal,
	// and a parse refusal must flow through the same exit-2 path as a
	// startup refusal (docs/auto.md), not escape to the launcher's catch.
	try {
		for (let i = 0; i < argv.length; i += 1) {
			const arg = argv[i];
			if (arg === undefined) break;
			if (arg === "--help" || arg === "-h") {
				process.stdout.write(autoHelp());
				return 0;
			}
			const value = (): string => {
				const v = argv[i + 1];
				if (v === undefined || v.startsWith("--")) {
					autoUsageError(`torus auto: ${arg} needs a value\n\n${AUTO_USAGE}`);
				}
				i += 1;
				return v;
			};
			if (arg === "--roadmap") roadmapPath = path.resolve(value());
			else if (arg === "--plan") planPath = path.resolve(value());
			else if (arg === "--cwd") cwd = value();
			else if (arg === "--stage-timeout-ms") {
				const raw = value();
				const parsed = Number(raw);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					autoUsageError(`--stage-timeout-ms must be a positive number, got "${raw}"`);
				}
				stageTimeoutMs = parsed;
			} else if (arg === "--skills") {
				const raw = value();
				skills = raw
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
			} else if (arg.startsWith("--")) {
				autoUsageError(`unknown flag: ${arg}`);
			} else {
				words.push(arg);
			}
		}
		objective = words.join(" ").trim();
		if (cwd === undefined) {
			refusal(
				"--cwd is required: pass the driven checkout (a worktree or scratch copy) — the driver never lands in the current directory by default",
			);
		}
		return await printReport(
			await startAuto({
				objective,
				roadmapPath,
				planPath,
				cwd,
				stageTimeoutMs,
				skills,
			}),
		);
	} catch (err) {
		if (err instanceof AutoRefusal) {
			process.stderr.write(`torus auto: ${err.message}\n`);
			return 2;
		}
		throw err;
	}
}

function printReport(report: AutoReport): number {
	for (const stage of report.stages) {
		const bits = [
			`stage ${stage.stage}:`,
			stage.ok ? "ok" : `FAILED${stage.error ? ` (${stage.error})` : ""}`,
		];
		if (stage.verdict !== undefined) bits.push(`verdict=${stage.verdict}`);
		if (stage.artifact !== undefined) bits.push(`artifact=${stage.artifact}`);
		bits.push(`durationMs=${stage.durationMs}`);
		process.stdout.write(`${bits.join(" ")}\n`);
	}
	process.stdout.write(
		`report: ok=${report.ok} exitCode=${report.exitCode}\nJSON: ${JSON.stringify(report)}\n`,
	);
	return report.exitCode;
}

function autoHelp() {
	return [
		"torus auto - unattended plan → gate → execute → lens stage chain",
		"",
		"Usage:",
		"  torus auto <objective> --cwd <dir> [--roadmap <path>] [--plan <path>]",
		"             [--stage-timeout-ms <n>] [--skills <a,b>]",
		"",
		"--cwd is REQUIRED: the driven checkout (a worktree or scratch copy) —",
		"the driver never lands in the current directory by default. PLAN and",
		"EXECUTE run as delegations; GATE and LENS run as root one-shots (node",
		"torus.mjs -a --mode json -p …). Every stage gates on a machine signal",
		"(docs/machine-contracts.md) and races --stage-timeout-ms (default",
		"600000); on timeout the delegation is stopped or the child killed and",
		"the stage fails named. The report prints per-stage lines plus JSON;",
		"exit 0 all-pass, 1 named failure, 2 refusal.",
		"",
		"See docs/auto.md.",
		"",
	].join("\n");
}
