#!/usr/bin/env node
// torus overhead bench — measures the harness-layer context cost torus adds on
// top of the stock pi engine. Identical, read-only, repo-local prompts run
// through two engine spawns: stock (bare engine, JSON mode) and torus (same
// argv plus the canonical child extension set — exactly what delegations get).
// See docs/efficiency.md for method and caveats, scripts/bench/ for the
// framework modules.
//
// The extension sources are TypeScript with .js import specifiers, so this
// entry re-execs itself once under --experimental-strip-types plus the tests'
// resolve hook (the npm script stays flag-free); --help exits before that.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BOOTSTRAP_ENV = "TORUS_BENCH_BOOTSTRAP";

const USAGE = `torus overhead bench — torus vs stock pi token/cost comparison

Usage:
  npm run bench:overhead -- [flags]
  node scripts/bench.mjs [same flags]

Runs a fixed set of read-only repo-local tasks through two engine configs,
interleaved with rotated config order, discards warmup runs, and prints a
markdown report of medians ± half-IQR per task × config, plus Δ-vs-noise
verdict tables.

Options:
  --model <ids>     comma-separated model ids, one full sweep each (default: zai/glm-5.3-flash)
  --runs N          measured runs per task × config (default: 3)
  --warmup N        warmup runs per task × config, discarded from stats (default: 1)
  --tasks <ids>     comma-separated subset of task ids (default: all)
  --stock-only      run only the bare-engine config (no delta rows)
  --torus-only      run only the torus-extension config (no delta rows)
  --timeout <sec>   per-run wall-clock cap, SIGKILL after (default: 600)
  --json <path>     write the raw-records JSON sidecar to <path>
  --html <path>     write the self-contained HTML report to <path>
  --help            print this usage

Exit status: 0 when every run (warmups included) completed, 1 otherwise;
failures are reported and the bench keeps going.

The bench spawns the real engine and calls the model API — run it with valid
credentials. The unit tests (tests/bench.test.mjs) never do.`;

function parseArgs(argv) {
	const opts = {
		models: ["zai/glm-5.3-flash"],
		runs: 3,
		warmup: 1,
		tasks: "",
		stockOnly: false,
		torusOnly: false,
		timeoutSec: 600,
		jsonPath: "",
		htmlPath: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--model") {
			const ids = next()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (ids.length === 0) throw new Error("--model needs at least one id");
			opts.models = ids;
		} else if (arg === "--runs") {
			opts.runs = Number.parseInt(next(), 10);
			if (!Number.isInteger(opts.runs) || opts.runs < 1)
				throw new Error("--runs must be an integer >= 1");
		} else if (arg === "--warmup") {
			opts.warmup = Number.parseInt(next(), 10);
			if (!Number.isInteger(opts.warmup) || opts.warmup < 0)
				throw new Error("--warmup must be an integer >= 0");
		} else if (arg === "--tasks") opts.tasks = next();
		else if (arg === "--stock-only") opts.stockOnly = true;
		else if (arg === "--torus-only") opts.torusOnly = true;
		else if (arg === "--timeout") {
			opts.timeoutSec = Number.parseInt(next(), 10);
			if (!Number.isInteger(opts.timeoutSec) || opts.timeoutSec < 1)
				throw new Error("--timeout must be an integer >= 1 (seconds)");
		} else if (arg === "--json") opts.jsonPath = next();
		else if (arg === "--html") opts.htmlPath = next();
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	if (opts.stockOnly && opts.torusOnly)
		throw new Error("--stock-only and --torus-only are mutually exclusive");
	return opts;
}

const argv = process.argv.slice(2);
const opts = parseArgs(argv);
if (opts.help) {
	console.log(USAGE);
	process.exit(0);
}

if (!process.env[BOOTSTRAP_ENV]) {
	const hook = pathToFileURL(path.join(ROOT, "tests", "resolve-ts-hook.mjs")).href;
	const rerun = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--import", hook, fileURLToPath(import.meta.url), ...argv],
		{ stdio: "inherit", env: { ...process.env, [BOOTSTRAP_ENV]: "1" } },
	);
	process.exit(rerun.status ?? 1);
}

const { selectTasks } = await import("./bench/tasks.mjs");
const { buildSchedule } = await import("./bench/stats.mjs");
const { CONFIGS, aggregateEventLines, buildArgs, runEngineOnce } = await import(
	"./bench/engine-run.mjs"
);
const { buildHtml, buildJson, buildMarkdown, rollupRecords } = await import("./bench/report.mjs");
const { engineChildEnv, resolveEngineBin } = await import("../extensions/engine-child.ts");

const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const gitCommit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
	cwd: ROOT,
	encoding: "utf8",
});
const commit = gitCommit.status === 0 ? gitCommit.stdout.trim() : "unknown";

const configs = CONFIGS.filter((c) =>
	opts.stockOnly ? c === "stock" : opts.torusOnly ? c === "torus" : true,
);
const tasks = selectTasks(opts.tasks);
const engineBin = resolveEngineBin();
const meta = {
	generatedAt: new Date().toISOString(),
	models: opts.models,
	engineBin: engineBinLabel(engineBin, ROOT),
	enginePin: packageJson.devDependencies?.["@earendil-works/pi-coding-agent"] ?? "unknown",
	torusVersion: packageJson.version,
	commit,
	runs: opts.runs,
	warmup: opts.warmup,
	timeoutSec: opts.timeoutSec,
	taskCount: tasks.length,
	tasks: tasks.map((t) => ({ id: t.id, tier: t.tier })),
	configs,
};

const records = [];
for (const model of opts.models) {
	const plan = buildSchedule(tasks, configs, opts.runs, opts.warmup);
	for (const step of plan) {
		const task = tasks.find((t) => t.id === step.taskId);
		const args = buildArgs(step.config, model, task.prompt, ROOT);
		const startedAt = Date.now();
		const result = await runEngineOnce(
			engineBin,
			args,
			ROOT,
			step.config === "torus" ? engineChildEnv() : process.env,
			opts.timeoutSec * 1000,
		);
		const ms = Date.now() - startedAt;
		const aggregate = aggregateEventLines(result.lines);
		const ok = result.exitCode === 0 && aggregate.turns > 0 && !result.spawnError;
		const failure = result.spawnError
			? `spawn failed: ${result.spawnError}`
			: result.timedOut
				? `timed out after ${opts.timeoutSec}s`
				: result.exitCode !== 0
					? `exit ${result.exitCode}`
					: "no assistant turn in event stream";
		records.push({
			model,
			taskId: step.taskId,
			config: step.config,
			run: step.run,
			warmup: step.warmup,
			ok,
			ms,
			aggregate,
			stderr: result.stderr,
			failure,
		});
		console.error(
			`${ok ? "ok" : "FAIL"} ${model}/${step.taskId}/${step.config} ${step.warmup ? "warmup" : `run ${step.run}/${opts.runs}`} — ${ms}ms, ${aggregate.turns} turn(s), ${aggregate.malformed} malformed line(s)`,
		);
	}
}

const rollup = rollupRecords(records, tasks, configs, opts.models);
console.log(buildMarkdown(rollup, meta, records));
if (opts.htmlPath) {
	writeFileSync(path.resolve(opts.htmlPath), buildHtml(rollup, meta, records));
	console.error(`html report: ${path.resolve(opts.htmlPath)}`);
}
if (opts.jsonPath) {
	writeFileSync(path.resolve(opts.jsonPath), buildJson(meta, records));
	console.error(`json sidecar: ${path.resolve(opts.jsonPath)}`);
}
process.exit(records.some((r) => !r.ok) ? 1 : 0);
