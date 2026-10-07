// Pure aggregation + rendering for the torus-vs-stock-pi overhead bench.
//
// Split from scripts/bench-overhead.mjs so tests can exercise the aggregation,
// delta math, arg construction, and table rendering without spawning engines
// or touching the network. The event-stream folding deliberately goes through
// the shared reduceEngineEvent pipeline (extensions/engine-child.ts) — the
// same reducer roster/team/fleet consume — so the bench can never drift from
// production tally semantics. Cost cells render via the shared formatCost.
//
// Loaded under node --experimental-strip-types (the entry bootstraps those
// flags before importing this module).

import {
	childExtensionArgs,
	parseEngineEvent,
	reduceEngineEvent,
} from "../extensions/engine-child.ts";
import { formatCost } from "../extensions/fsutil.ts";

/** Fixed, read-only, repo-local task set — identical prompts for both configs. */
export const TASKS = [
	{
		id: "readme-name",
		prompt: "Read README.md and state the project name in one sentence. Do not modify any files.",
	},
	{
		id: "register-tool-count",
		prompt:
			'Count how many times "registerTool" appears across the files under extensions/ and report just the number. Do not modify any files.',
	},
	{
		id: "agents-doc-headings",
		prompt: "Open docs/agents.md and list its section headings verbatim. Do not modify any files.",
	},
];

export const CONFIGS = ["stock", "torus"];

/**
 * Engine argv for one bench config. Stock is the bare engine in JSON mode;
 * torus appends the canonical child extension set (exactly what delegations
 * get from childExtensionArgs). Unknown configs throw.
 */
export function buildArgs(config, model, prompt, root) {
	const base = ["--mode", "json", "--model", model, "-p", prompt];
	if (config === "torus") return [...base, ...childExtensionArgs(root)];
	if (config === "stock") return base;
	throw new Error(`unknown bench config: ${config}`);
}

/**
 * Fold a run's JSONL event lines into one tally: turns, input/output tokens,
 * cache read/write tokens, and engine-computed cost, via the shared
 * parseEngineEvent + reduceEngineEvent pair. Unparseable or non-object lines
 * are counted in `malformed` and skipped — never fatal.
 */
export function aggregateRuns(eventLines) {
	const tally = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
	};
	let malformed = 0;
	for (const line of eventLines) {
		const record = parseEngineEvent(line);
		if (record === null) {
			malformed += 1;
			continue;
		}
		reduceEngineEvent(record, tally);
	}
	return {
		turns: tally.turns,
		tokensIn: tally.tokensIn,
		tokensOut: tally.tokensOut,
		cacheRead: tally.cacheRead,
		cacheWrite: tally.cacheWrite,
		cost: tally.cost,
		malformed,
	};
}

/** Field-wise torus − stock delta (the harness-layer overhead measurement). */
export function computeDelta(torus, stock) {
	return {
		turns: torus.turns - stock.turns,
		tokensIn: torus.tokensIn - stock.tokensIn,
		tokensOut: torus.tokensOut - stock.tokensOut,
		cacheRead: torus.cacheRead - stock.cacheRead,
		cacheWrite: torus.cacheWrite - stock.cacheWrite,
		cost: torus.cost - stock.cost,
	};
}

/** Per-field mean across a config's completed runs; empty input folds to zeros. */
export function meanAggregate(aggregates) {
	const zero = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	if (aggregates.length === 0) return { ...zero };
	const sum = aggregates.reduce(
		(acc, a) => ({
			turns: acc.turns + a.turns,
			tokensIn: acc.tokensIn + a.tokensIn,
			tokensOut: acc.tokensOut + a.tokensOut,
			cacheRead: acc.cacheRead + a.cacheRead,
			cacheWrite: acc.cacheWrite + a.cacheWrite,
			cost: acc.cost + a.cost,
		}),
		zero,
	);
	const n = aggregates.length;
	return {
		turns: sum.turns / n,
		tokensIn: sum.tokensIn / n,
		tokensOut: sum.tokensOut / n,
		cacheRead: sum.cacheRead / n,
		cacheWrite: sum.cacheWrite / n,
		cost: sum.cost / n,
	};
}

/**
 * Render string-cell rows (rows[0] is the header) as a GitHub-markdown table.
 * The first column is left-aligned, the rest right-aligned; every emitted
 * line has identical width.
 */
export function renderTable(rows) {
	if (rows.length === 0) return "";
	const nCols = Math.max(...rows.map((r) => r.length));
	const widths = [];
	for (let i = 0; i < nCols; i++) {
		widths[i] = Math.max(3, ...rows.map((r) => String(r[i] ?? "").length));
	}
	const cell = (value, i) =>
		i === 0 ? String(value ?? "").padEnd(widths[i]) : String(value ?? "").padStart(widths[i]);
	const renderRow = (cells) => `| ${cells.map((c, i) => cell(c, i)).join(" | ")} |`;
	const lines = [renderRow(rows[0])];
	lines.push(
		`| ${widths.map((w, i) => (i === 0 ? "-".repeat(w) : `:${"-".repeat(w - 1)}`)).join(" | ")} |`,
	);
	for (const row of rows.slice(1)) lines.push(renderRow(row));
	return lines.join("\n");
}

const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtTurns = (n) => (Number.isInteger(n) ? fmtInt(n) : n.toFixed(1));
const fmtDeltaInt = (n) => (n === 0 ? "0" : n > 0 ? `+${fmtInt(n)}` : fmtInt(n));
const fmtDeltaCost = (n) => {
	if (!Number.isFinite(n)) return "—";
	if (n === 0) return "$0";
	const sign = n < 0 ? "-" : "+";
	return `${sign}${formatCost(Math.abs(n), true)}`;
};

function aggregateCells(agg, ms) {
	return [
		fmtTurns(agg.turns),
		fmtInt(agg.tokensIn),
		fmtInt(agg.tokensOut),
		fmtInt(agg.cacheRead),
		fmtInt(agg.cacheWrite),
		formatCost(agg.cost, agg.tokensIn + agg.tokensOut > 0) || "$0",
		fmtInt(ms),
	];
}

function deltaCells(delta, ms) {
	return [
		fmtTurns(delta.turns),
		fmtDeltaInt(delta.tokensIn),
		fmtDeltaInt(delta.tokensOut),
		fmtDeltaInt(delta.cacheRead),
		fmtDeltaInt(delta.cacheWrite),
		fmtDeltaCost(delta.cost),
		fmtDeltaInt(ms),
	];
}

/**
 * Assemble the full bench report from per-run records. Each record is
 * { taskId, config, run, ok, ms, aggregate? } — ok means the engine exited 0
 * and produced at least one assistant turn. Emits a markdown table (one row
 * per task × config, a delta row per task when both configs completed, then
 * totals) plus footnote lines for skips and failures.
 */
export function buildReport(records, meta) {
	const byTask = new Map();
	for (const task of meta.tasks) {
		byTask.set(task.id, {});
	}
	for (const rec of records) {
		const bucket = byTask.get(rec.taskId);
		const list = bucket[rec.config] ?? { ok: [], failed: [] };
		bucket[rec.config] = list;
		list[rec.ok ? "ok" : "failed"].push(rec);
	}

	const meanMs = (list) =>
		list.ok.length === 0 ? 0 : list.ok.reduce((a, r) => a + r.ms, 0) / list.ok.length;

	const rows = [
		[
			"task",
			"config",
			"turns",
			"tokens in",
			"tokens out",
			"cache read",
			"cache write",
			"cost",
			"ms",
		],
	];
	const totals = {};
	for (const cfg of meta.configs) totals[cfg] = { sum: meanAggregate([]), ms: 0, n: 0 };

	for (const task of meta.tasks) {
		const bucket = byTask.get(task.id);
		const means = {};
		for (const cfg of meta.configs) {
			if (!bucket[cfg]) continue;
			means[cfg] = meanAggregate(bucket[cfg].ok.map((r) => r.aggregate));
			const ms = meanMs(bucket[cfg]);
			if (bucket[cfg].ok.length > 0) {
				rows.push([task.id, cfg, ...aggregateCells(means[cfg], ms)]);
				totals[cfg].sum = addTotals(totals[cfg].sum, means[cfg]);
				totals[cfg].ms += ms;
				totals[cfg].n += 1;
			} else {
				rows.push([
					task.id,
					cfg,
					`failed (${bucket[cfg].failed.length} run(s))`,
					"",
					"",
					"",
					"",
					"",
					"",
				]);
			}
		}
		if (means.stock && means.torus && bucket.stock?.ok.length > 0 && bucket.torus?.ok.length > 0) {
			rows.push([
				task.id,
				"Δ torus−stock",
				...deltaCells(
					computeDelta(means.torus, means.stock),
					meanMs(bucket.torus) - meanMs(bucket.stock),
				),
			]);
		}
	}

	let bothTotals = true;
	for (const cfg of meta.configs) {
		if (totals[cfg].n > 0) {
			rows.push(["totals", cfg, ...aggregateCells(totals[cfg].sum, totals[cfg].ms)]);
		} else {
			bothTotals = false;
		}
	}
	if (bothTotals && meta.configs.length === 2) {
		const stockMs = totals.stock.ms;
		const torusMs = totals.torus.ms;
		rows.push([
			"totals",
			"Δ torus−stock",
			...deltaCells(computeDelta(totals.torus.sum, totals.stock.sum), torusMs - stockMs),
		]);
	}

	const lines = [
		`# torus overhead bench — ${meta.tasks.length} tasks · model \`${meta.model}\` · ${meta.runsLabel}`,
		`engine: \`${meta.engineBin}\` · config axis: ${meta.configs.join(" vs ")}`,
		"",
		renderTable(rows),
		"",
	];

	const malformed = records.reduce((a, r) => a + (r.aggregate?.malformed ?? 0), 0);
	if (malformed > 0)
		lines.push(`Skipped ${malformed} malformed event line(s) — counted, never fatal.`);
	const failed = records.filter((r) => !r.ok);
	if (failed.length > 0) {
		lines.push(`${failed.length} run(s) failed:`);
		for (const rec of failed) {
			const tail = (rec.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
			lines.push(
				`- ${rec.taskId}/${rec.config} run ${rec.run}: ${rec.failure}${tail ? ` — ${tail}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

function addTotals(acc, agg) {
	return {
		turns: acc.turns + agg.turns,
		tokensIn: acc.tokensIn + agg.tokensIn,
		tokensOut: acc.tokensOut + agg.tokensOut,
		cacheRead: acc.cacheRead + agg.cacheRead,
		cacheWrite: acc.cacheWrite + agg.cacheWrite,
		cost: acc.cost + agg.cost,
	};
}
