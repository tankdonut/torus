#!/usr/bin/env node
// Release gate over the bench sidecar: compares the two newest comparable
// runs per model and exits nonzero when a gated overhead delta regresses
// beyond tolerance. Reads the sidecar only — no engine spawns, no network.
// The gate logic lives in scripts/bench/gate.mjs; see docs/release-workflow.md
// for the CI wiring and docs/efficiency.md for what the deltas mean.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_ENV = "TORUS_BENCH_GATE_BOOTSTRAP";

const USAGE = `torus bench gate — fail a release when overhead regresses

Usage:
  npm run bench:gate -- [sidecar]
  node scripts/bench-gate.mjs [sidecar]

sidecar defaults to docs/bench-records.json. Compares the newest run with
each model's prior comparable run; gates on the structural overhead deltas
(cache read, cost) with a relative-plus-floor tolerance defined in
scripts/bench/gate.mjs.

Exit status: 0 within tolerance, 1 regression, 2 no comparable data
(empty sidecar or no model with both configs complete).`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(USAGE);
	process.exit(0);
}
if (argv.length > 1) {
	console.error("expected at most one argument (sidecar path)");
	process.exit(2);
}

// The report modules import TypeScript sources with .js specifiers, so this
// entry re-execs itself once under --experimental-strip-types plus the tests'
// resolve hook (same bootstrap as scripts/bench.mjs; --help exits before).
if (!process.env[BOOTSTRAP_ENV]) {
	const root = path.resolve(HERE, "..");
	const hook = pathToFileURL(path.join(root, "tests", "resolve-ts-hook.mjs")).href;
	const rerun = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--import", hook, fileURLToPath(import.meta.url), ...argv],
		{ stdio: "inherit", env: { ...process.env, [BOOTSTRAP_ENV]: "1" } },
	);
	process.exit(rerun.status ?? 2);
}

const { benchGateReport } = await import("./bench/gate.mjs");
const { parseRunsHistory } = await import("./bench/report.mjs");

const sidecar = path.resolve(argv[0] ?? "docs/bench-records.json");
let text = "";
try {
	text = readFileSync(sidecar, "utf8");
} catch {
	console.error(`bench gate: cannot read sidecar ${sidecar}`);
	process.exit(2);
}
const runs = parseRunsHistory(text);
const { markdown, exitCode } = benchGateReport(runs);
console.log(markdown);
process.exit(exitCode);
