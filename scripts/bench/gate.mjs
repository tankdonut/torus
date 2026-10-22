// Release gate over the bench sidecar: judges the newest run's overhead
// deltas against the model's most recent prior comparable run. Pure functions
// over parsed sidecar runs — no engine, no network, unit-testable; the CLI
// wrapper lives in scripts/bench-gate.mjs.

import {
	configTotals,
	FIELDS,
	prevModelTotals,
	renderTable,
	rollupRecords,
	summaryMarkdown,
} from "./report.mjs";

/**
 * Fields the gate judges. Cache read and cost are the structural overhead
 * signals; each run pairs torus with stock on the same engine pin, so the
 * delta is engine-normalized and comparable across pins. Tokens in, turns,
 * and wall-clock stay ungated: they move with task behavior and network
 * jitter (see docs/efficiency.md, "Reading them").
 */
export const GATE_FIELDS = ["cacheRead", "cost"];

/**
 * A regression must beat BOTH the relative share of the prior delta and the
 * absolute floor: the share keeps big deltas tolerant of run-to-run wiggle,
 * the floor keeps tiny bases from hair-triggering on rounding-scale moves.
 * Current values live here, not in the docs.
 */
export const GATE_TOLERANCE = {
	cacheRead: { relative: 0.1, floor: 8000 },
	cost: { relative: 0.1, floor: 0.002 },
};

const fieldByKey = (key) => FIELDS.find((f) => f.key === key);

/**
 * Verdict rows for the newest sidecar run, one per gated field per model
 * with both configs complete. verdict: "pass" (movement within tolerance),
 * "fail" (regression beyond tolerance), or "skip" (no prior comparable run
 * for the model — first recorded run, nothing to gate against).
 * @param {Array<{meta: Record<string, unknown>, records: Array<Record<string, unknown>>}>} runs
 * @returns {{rows: Array<{model: string, key: string, delta: number, movement: number | null, threshold: number | null, verdict: "pass" | "fail" | "skip", prevVersion: string | null, enginePinChanged: boolean}>, meta: Record<string, unknown>, rollup: ReturnType<typeof rollupRecords>, history: Array<{meta: Record<string, unknown>, records: Array<Record<string, unknown>>}>}}
 */
export function gateVerdicts(runs) {
	const rows = [];
	const current = runs[runs.length - 1];
	const meta = current?.meta ?? {};
	const history = runs.slice(0, -1);
	const tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
	const configs = Array.isArray(meta.configs) ? meta.configs : ["stock", "torus"];
	const models = Array.isArray(meta.models) ? meta.models : [];
	const rollup = rollupRecords(current?.records ?? [], tasks, configs, models);
	for (const m of rollup) {
		const totals = configTotals(m.tasks);
		const a = totals.torus;
		const b = totals.stock;
		if (!a || !b || a.n === 0 || b.n === 0) continue;
		const prev = prevModelTotals(history, m.model);
		for (const key of GATE_FIELDS) {
			const delta = a[key] - b[key];
			const row = {
				model: m.model,
				key,
				delta,
				movement: null,
				threshold: null,
				verdict: "skip",
				prevVersion: null,
				enginePinChanged: false,
			};
			if (prev) {
				const prevDelta = prev.totals.torus[key] - prev.totals.stock[key];
				const tolerance = GATE_TOLERANCE[key];
				const movement = delta - prevDelta;
				const threshold = Math.max(Math.abs(prevDelta) * tolerance.relative, tolerance.floor);
				row.movement = movement;
				row.threshold = threshold;
				row.prevVersion = String(prev.meta.torusVersion ?? "?");
				row.enginePinChanged = String(prev.meta.enginePin ?? "") !== String(meta.enginePin ?? "");
				row.verdict = movement > threshold ? "fail" : "pass";
			}
			rows.push(row);
		}
	}
	return { rows, meta, rollup, history };
}

/**
 * Full gate report: the summary block (same table the bench reports lead
 * with) plus a verdict table. exitCode: 0 pass, 1 regression, 2 nothing
 * comparable (empty sidecar, no model with both configs complete).
 * @param {Array<{meta: Record<string, unknown>, records: Array<Record<string, unknown>>}>} runs
 * @returns {{markdown: string, exitCode: number}}
 */
export function benchGateReport(runs) {
	const { rows, meta, rollup, history } = gateVerdicts(runs);
	if (rows.length === 0) {
		return {
			markdown:
				"## Bench gate\n\nNo model in the newest sidecar run has both configs complete — nothing to gate.",
			exitCode: 2,
		};
	}
	const lines = [...summaryMarkdown(rollup, meta, history), "### Gate verdicts", ""];
	const table = [["model", "field", "Δ now", "Δ prior", "movement", "tolerance", "verdict"]];
	for (const r of rows) {
		const f = fieldByKey(r.key);
		table.push([
			r.model,
			f?.label ?? r.key,
			f?.fmtDelta(r.delta) ?? String(r.delta),
			r.movement === null ? "—" : (f?.fmtDelta(r.delta - r.movement) ?? ""),
			r.movement === null ? "—" : (f?.fmtDelta(r.movement) ?? ""),
			r.threshold === null
				? "—"
				: f.key === "cost"
					? `$${r.threshold.toFixed(4)}`
					: Math.round(r.threshold).toLocaleString("en-US"),
			r.verdict,
		]);
	}
	lines.push(renderTable(table), "");
	const priors = [
		...new Set(rows.filter((r) => r.prevVersion).map((r) => `torus ${r.prevVersion}`)),
	];
	if (priors.length > 0)
		lines.push(`Compared with ${priors.join(", ")} (prior comparable sidecar run per model).`);
	if (rows.some((r) => r.enginePinChanged))
		lines.push(
			"Engine pin changed between compared runs; each run pairs torus with stock on its own pin, so deltas stay engine-normalized.",
		);
	lines.push(
		"Verdicts: pass = movement within tolerance; fail = regression beyond tolerance; skip = first recorded run for the model.",
	);
	return {
		markdown: lines.join("\n"),
		exitCode: rows.some((r) => r.verdict === "fail") ? 1 : 0,
	};
}
