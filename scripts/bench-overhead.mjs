#!/usr/bin/env node
// torus overhead bench — measures the harness-layer context cost torus adds on
// top of the stock pi engine. Identical, read-only, repo-local prompts run
// through two engine spawns: stock (bare engine, JSON mode) and torus (same
// argv plus the canonical child extension set, TORUS_ENGINE_CHILD=1 — exactly
// what delegations get). Usage and cost fold out of the JSON event stream via
// the shared reduceEngineEvent pipeline; the torus − stock delta is torus's
// overhead. See docs/efficiency.md for method and caveats.
//
// The extension sources are TypeScript with .js import specifiers, so this
// entry re-execs itself once under --experimental-strip-types plus the tests'
// resolve hook (the npm script stays flag-free); --help exits before that.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BOOTSTRAP_ENV = "TORUS_BENCH_BOOTSTRAP";
const STDERR_CAP = 4000;

const USAGE = `torus overhead bench — torus vs stock pi token/cost comparison

Usage:
  npm run bench:overhead -- [--model <id>] [--runs N] [--stock-only|--torus-only]
                            [--timeout <seconds>]
  node scripts/bench-overhead.mjs [same flags]

Runs a fixed set of read-only repo-local tasks through two engine configs and
prints a markdown table of turns / tokens in/out / cache read/write / cost
per task per config, plus torus − stock delta rows and totals.

Options:
  --model <id>     model id for both configs (default: zai/glm-5.3-flash)
  --runs N         runs per task per config; the table shows per-run means (default: 1)
  --stock-only     run only the bare-engine config (no delta rows)
  --torus-only     run only the torus-extension config (no delta rows)
  --timeout <sec>  per-run wall-clock cap, SIGKILL after (default: 600)
  --help           print this usage

Exit status: 0 when every run completed, 1 when any run failed (failures and
malformed event lines are reported; the bench keeps going).

The bench spawns the real engine and calls the model API — run it with valid
credentials. The unit tests (tests/bench-overhead.test.mjs) never do.`;

function parseArgs(argv) {
	const opts = {
		model: "zai/glm-5.3-flash",
		runs: 1,
		stockOnly: false,
		torusOnly: false,
		timeoutSec: 600,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--model") opts.model = next();
		else if (arg === "--runs") {
			opts.runs = Number.parseInt(next(), 10);
			if (!Number.isInteger(opts.runs) || opts.runs < 1)
				throw new Error("--runs must be an integer >= 1");
		} else if (arg === "--stock-only") opts.stockOnly = true;
		else if (arg === "--torus-only") opts.torusOnly = true;
		else if (arg === "--timeout") {
			opts.timeoutSec = Number.parseInt(next(), 10);
			if (!Number.isInteger(opts.timeoutSec) || opts.timeoutSec < 1)
				throw new Error("--timeout must be an integer >= 1 (seconds)");
		} else if (arg === "--help" || arg === "-h") opts.help = true;
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

const { TASKS, CONFIGS, aggregateRuns, buildArgs, buildReport } = await import(
	"./bench-overhead.lib.mjs"
);
const { engineChildEnv, resolveEngineBin } = await import("../extensions/engine-child.ts");

function runEngineOnce(bin, args, cwd, env, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let buffer = "";
		const lines = [];
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			buffer += stdoutDecoder.write(chunk);
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				lines.push(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length >= STDERR_CAP) return;
			stderr += stderrDecoder.write(chunk).slice(0, STDERR_CAP - stderr.length);
		});
		const finish = (exitCode, spawnError) => {
			clearTimeout(timer);
			buffer += stdoutDecoder.end();
			if (buffer.length > 0) lines.push(buffer);
			resolve({ exitCode, stderr: stderr + stderrDecoder.end(), lines, timedOut, spawnError });
		};
		child.on("error", (err) => finish(1, err));
		child.on("close", (code) => finish(code ?? 1));
	});
}

const configs = CONFIGS.filter((c) =>
	opts.stockOnly ? c === "stock" : opts.torusOnly ? c === "torus" : true,
);
const engineBin = resolveEngineBin();
const records = [];

for (const task of TASKS) {
	for (const config of configs) {
		for (let run = 1; run <= opts.runs; run++) {
			const args = buildArgs(config, opts.model, task.prompt, ROOT);
			const startedAt = Date.now();
			const result = await runEngineOnce(
				engineBin,
				args,
				ROOT,
				config === "torus" ? engineChildEnv() : process.env,
				opts.timeoutSec * 1000,
			);
			const ms = Date.now() - startedAt;
			const aggregate = aggregateRuns(result.lines);
			const ok = result.exitCode === 0 && aggregate.turns > 0 && !result.spawnError;
			const failure = result.spawnError
				? `spawn failed: ${result.spawnError}`
				: result.timedOut
					? `timed out after ${opts.timeoutSec}s`
					: result.exitCode !== 0
						? `exit ${result.exitCode}`
						: "no assistant turn in event stream";
			records.push({
				taskId: task.id,
				config,
				run,
				ok,
				ms,
				aggregate,
				stderr: result.stderr,
				failure,
			});
			console.error(
				`${ok ? "ok" : "FAIL"} ${task.id}/${config} run ${run}/${opts.runs} — ${ms}ms, ${aggregate.turns} turn(s), ${aggregate.malformed} malformed line(s)`,
			);
		}
	}
}

console.log(
	buildReport(records, {
		tasks: TASKS,
		configs,
		model: opts.model,
		runsLabel: `${opts.runs} run(s) per task per config`,
		engineBin,
	}),
);
process.exit(records.some((r) => !r.ok) ? 1 : 0);
