#!/usr/bin/env node
// torus startup bench — cold-start wall-clock cost of the harness layer:
// `torus --list-models` through runtime/bin/torus.mjs vs the bare pinned
// engine, interleaved run-for-run with rotated order, warmups discarded,
// medians reported. `--list-models` exits before any model call, so no
// tokens are spent; a spawn is keyless (same path make.sh smoke uses).
//
// Run from the repo root:
//   npm run bench:startup
//   node scripts/bench/startup.mjs --runs 7 --warmup 2

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STOCK_BIN = path.join(ROOT, "node_modules", ".bin", "pi");
const TORUS_LAUNCHER = path.join(ROOT, "runtime", "bin", "torus.mjs");

const USAGE = `torus startup bench — torus vs stock engine cold-start wall time

Usage:
  npm run bench:startup -- [flags]
  node scripts/bench/startup.mjs [same flags]

Each measured round runs both configs back to back (which config goes first
alternates per round), through a full spawn of \`--list-models\`, keyless and
token-free. Warmup rounds are discarded. Reports median/min/max per config
plus the torus-minus-stock delta. Exits non-zero if any measured run fails.

Options:
  --runs N          measured rounds (default: 5)
  --warmup N        discarded warmup rounds (default: 1)
  --timeout <sec>   per-spawn wall-clock cap (default: 60)
  -h, --help        show this help
`;

function fail(message) {
	console.error(`startup: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { runs: 5, warmup: 1, timeoutSec: 60 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			process.exit(0);
		} else if (arg === "--runs" || arg === "--warmup" || arg === "--timeout") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 1) fail(`${arg} needs a positive integer`);
			if (arg === "--runs") opts.runs = value;
			else if (arg === "--warmup") opts.warmup = value;
			else opts.timeoutSec = value;
		} else {
			fail(`unknown flag: ${arg}\n\n${USAGE}`);
		}
	}
	return opts;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function enginePin() {
	try {
		const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
		return pkg.devDependencies?.["@earendil-works/pi-coding-agent"] ?? null;
	} catch {
		return null;
	}
}

/** Times one spawn; failures throw instead of returning a sample. */
function timedSpawn(command, args, timeoutSec) {
	const start = performance.now();
	const run = spawnSync(command, args, {
		stdio: ["ignore", "ignore", "pipe"],
		timeout: timeoutSec * 1000,
		encoding: "utf8",
	});
	const ms = performance.now() - start;
	const failed = run.error !== undefined || run.status !== 0 || (run.signal ?? "") !== "";
	if (failed) {
		const why =
			run.error?.message ??
			(run.signal ? `killed by ${run.signal} (timeout?)` : `exit ${run.status}`);
		const tail = (run.stderr ?? "").split("\n").filter(Boolean).slice(-3).join("\n\t");
		throw new Error(`${why}${tail ? `\n\t${tail}` : ""}`);
	}
	return ms;
}

function fmtMs(ms) {
	return ms >= 100 ? ms.toFixed(1) : ms.toFixed(2);
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!existsSync(STOCK_BIN)) {
		fail(`stock engine missing at ${STOCK_BIN} — run npm install first`);
	}

	const configs = [
		{ id: "stock", command: STOCK_BIN, args: ["--list-models"] },
		{ id: "torus", command: process.execPath, args: [TORUS_LAUNCHER, "--list-models"] },
	];
	const samples = { stock: [], torus: [] };

	const totalRounds = opts.warmup + opts.runs;
	for (let round = 0; round < totalRounds; round++) {
		const warmup = round < opts.warmup;
		// rotate which config leads each round so background drift hits both sides
		const order = round % 2 === 0 ? configs : [...configs].reverse();
		for (const config of order) {
			const ms = timedSpawn(config.command, config.args, opts.timeoutSec);
			if (!warmup) samples[config.id].push(ms);
			console.log(
				`${warmup ? "warmup" : `run ${samples[config.id].length}/${opts.runs}`} ` +
					`${config.id} ${fmtMs(ms)}ms`,
			);
		}
	}

	const pin = enginePin();
	const meta = {
		date: new Date().toISOString(),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		enginePin: pin ?? "unknown",
		runs: opts.runs,
		warmup: opts.warmup,
	};
	const results = configs.map((config) => {
		const values = samples[config.id];
		return {
			config: config.id,
			medianMs: median(values),
			minMs: Math.min(...values),
			maxMs: Math.max(...values),
		};
	});
	const delta = results[1].medianMs - results[0].medianMs;

	console.log(JSON.stringify({ meta, results, deltaMs: delta }, null, 2));
	console.log();
	console.log("---");
	console.log();
	console.log(
		`# startup bench — ${meta.platform}, node ${meta.node}, pi@${meta.enginePin}, ${meta.date}`,
	);
	console.log();
	console.log(
		`Cold start via \`--list-models\`, ${opts.runs} measured runs, ${opts.warmup} warmup discarded, order rotated.`,
	);
	console.log();
	console.log("| config | median ms | min ms | max ms | runs |");
	console.log("| ------ | --------: | -----: | -----: | ---: |");
	for (const r of results) {
		console.log(
			`| \`${r.config}\` | ${fmtMs(r.medianMs)} | ${fmtMs(r.minMs)} | ${fmtMs(r.maxMs)} | ${opts.runs} |`,
		);
	}
	console.log();
	console.log(
		`Δ torus − stock: **${fmtMs(delta)}ms** median cold-start cost of the harness layer.`,
	);
}

main();
