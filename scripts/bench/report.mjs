// Report rendering for the bench: pure functions from per-run records to the
// three artifact forms — GitHub-flavored markdown (docs + stdout), a
// self-contained HTML report with inline SVG distribution charts, and a JSON
// sidecar carrying every raw record so the numbers stay auditable. No engine
// spawns, no fs: writers live in the entry script.

import path from "node:path";
import { formatCost } from "../../extensions/fsutil.ts";
import { classifySignal, summarize } from "./stats.mjs";

const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtCost = (n) => formatCost(n, true) || "$0";
const fmtDeltaInt = (n) => (n === 0 ? "0" : n > 0 ? `+${fmtInt(n)}` : fmtInt(n));
const fmtDeltaCost = (n) => {
	if (!Number.isFinite(n)) return "—";
	if (n === 0) return "$0";
	return `${n < 0 ? "-" : "+"}${formatCost(Math.abs(n), true)}`;
};
const fmtMs = (n) => `${fmtInt(n)} ms`;

/** Metric axis of the report: aggregate fields plus wall-clock ms. */
export const FIELDS = [
	{ key: "turns", label: "turns", fmt: fmtInt, fmtDelta: fmtDeltaInt },
	{ key: "tokensIn", label: "tokens in", fmt: fmtInt, fmtDelta: fmtDeltaInt },
	{ key: "tokensOut", label: "tokens out", fmt: fmtInt, fmtDelta: fmtDeltaInt },
	{ key: "cacheRead", label: "cache read", fmt: fmtInt, fmtDelta: fmtDeltaInt },
	{ key: "cacheWrite", label: "cache write", fmt: fmtInt, fmtDelta: fmtDeltaInt },
	{ key: "cost", label: "cost", fmt: fmtCost, fmtDelta: fmtDeltaCost },
	{ key: "ms", label: "ms", fmt: fmtMs, fmtDelta: fmtDeltaInt },
];

/**
 * Public label for the engine binary: repo-relative when it lives under the
 * repo root, bare basename otherwise (e.g. a TORUS_ENGINE_BIN override
 * outside the tree). Reports are committed artifacts — machine-local
 * absolute paths must never land in them.
 * @param {string} bin
 * @param {string} root
 */
export function engineBinLabel(bin, root) {
	const rel = path.relative(root, bin);
	if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
	return path.basename(bin);
}

/**
 * Field accessor: aggregate fields read from the run's folded event tally,
 * wall-clock from the record itself.
 * @param {{aggregate?: Record<string, number>, ms: number}} rec
 * @param {string} key
 */
export function fieldValue(rec, key) {
	if (key === "ms") return rec.ms ?? 0;
	return rec.aggregate?.[key] ?? 0;
}

/**
 * Roll measured records up to per-model → per-task → per-config summaries.
 * Warmups are excluded (they ran, they are in the JSON sidecar, they do not
 * count). Failed runs never contribute values; their count is kept.
 * @param {Array<Record<string, unknown>>} records
 * @param {ReadonlyArray<{id: string, tier: string}>} tasks
 * @param {string[]} configs
 * @param {string[]} models
 */
export function rollupRecords(records, tasks, configs, models) {
	return models.map((model) => ({
		model,
		tasks: tasks.map((task) => ({
			task,
			perConfig: Object.fromEntries(
				configs.map((config) => {
					const recs = records.filter(
						(r) => r.model === model && r.taskId === task.id && r.config === config && !r.warmup,
					);
					const oks = recs.filter((r) => r.ok);
					return [
						config,
						{
							measuredRuns: recs.length,
							okCount: oks.length,
							failCount: recs.length - oks.length,
							fields: Object.fromEntries(
								FIELDS.map((f) => [f.key, summarize(oks.map((r) => fieldValue(r, f.key)))]),
							),
						},
					];
				}),
			),
		})),
	}));
}

/**
 * Render string-cell rows (rows[0] is the header) as a GitHub-markdown table.
 * First column left-aligned, rest right-aligned, uniform line width.
 * @param {string[][]} rows
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

/**
 * Median cell with dispersion: `12,345 ±678` where the spread is half the
 * interquartile range (median ± IQR/2 spans the middle half of runs). With
 * fewer than two measured runs there is no dispersion basis — bare median.
 */
function medCell(summary, fmt) {
	if (summary.n < 2 || summary.iqr <= 0) return fmt(summary.med);
	return `${fmt(summary.med)} ±${fmt(summary.iqr / 2)}`;
}

const VERDICT_LABEL = {
	signal: "signal",
	noise: "within noise",
	flat: "flat",
};

/**
 * Delta rows (torus − stock) against observed noise for one rolled-up task.
 * Returns [] unless both configs completed at least one measured run.
 * @param {Record<string, ReturnType<typeof rollupRecords>[number]["tasks"][number]["perConfig"]>} perConfig
 * @param {number} measuredRuns
 */
export function deltaRows(perConfig, measuredRuns) {
	const a = perConfig.torus;
	const b = perConfig.stock;
	if (!a || !b || a.okCount === 0 || b.okCount === 0) return [];
	return FIELDS.map((f) => {
		const sa = a.fields[f.key];
		const sb = b.fields[f.key];
		const delta = sa.med - sb.med;
		const noise = Math.max(sa.iqr, sb.iqr);
		const verdict = classifySignal(delta, noise, measuredRuns);
		return {
			key: f.key,
			label: f.label,
			delta,
			noise,
			verdict,
			cells: [f.fmtDelta(delta), f.fmt(noise), verdict === null ? "—" : VERDICT_LABEL[verdict]],
		};
	});
}

/**
 * Full markdown report: header metadata, per-model medians tables (totals
 * included), per-model delta-vs-noise tables, failure footnotes.
 * @param {ReturnType<typeof rollupRecords>} rollup
 * @param {Record<string, unknown>} meta
 * @param {Array<Record<string, unknown>>} records
 */
export function buildMarkdown(rollup, meta, records) {
	const runs = Number(meta.runs ?? 1);
	const lines = [
		`# torus overhead bench — ${meta.taskCount} task(s) · ${runs} measured run(s) per task per config`,
		`model(s): ${meta.models.join(", ")} · engine: \`${meta.engineBin}\` (pin ${meta.enginePin}) · torus ${meta.torusVersion} · commit \`${meta.commit}\``,
		`generated ${meta.generatedAt} · ${meta.warmup} warmup run(s) per config discarded · config order rotated per pass (interleaved)`,
		"",
		"Cells are medians; `±` is half the interquartile range across measured runs. Verdicts: `signal` means the delta exceeds run-to-run noise (max IQR of the two configs).",
		"",
	];
	for (const m of rollup) {
		lines.push(`## ${m.model}`, "");
		const rows = [["task", "config", ...FIELDS.map((f) => f.label)]];
		const totals = Object.fromEntries(
			Object.keys(m.tasks[0]?.perConfig ?? {}).map((cfg) => [cfg, { n: 0 }]),
		);
		for (const t of m.tasks) {
			for (const [cfg, c] of Object.entries(t.perConfig)) {
				if (c.okCount > 0) {
					rows.push([t.task.id, cfg, ...FIELDS.map((f) => medCell(c.fields[f.key], f.fmt))]);
					const tot = totals[cfg];
					tot.n += 1;
					for (const f of FIELDS) {
						tot[f.key] = (tot[f.key] ?? 0) + c.fields[f.key].med;
						tot[`${f.key}Half`] = (tot[`${f.key}Half`] ?? 0) + c.fields[f.key].iqr / 2;
					}
				} else {
					rows.push([t.task.id, cfg, `failed (${c.failCount} run(s))`, "", "", "", "", "", ""]);
				}
			}
		}
		for (const [cfg, tot] of Object.entries(totals)) {
			if (tot.n > 0) {
				rows.push([
					"totals",
					cfg,
					...FIELDS.map((f) =>
						tot[`${f.key}Half`] > 0
							? `${f.fmt(tot[f.key])} ±${f.fmt(tot[`${f.key}Half`])}`
							: f.fmt(tot[f.key]),
					),
				]);
			}
		}
		lines.push(renderTable(rows), "");

		const deltaTable = [["task", "field", "Δ med", "noise (IQR)", "verdict"]];
		for (const t of m.tasks) {
			for (const d of deltaRows(t.perConfig, runs)) {
				deltaTable.push([t.task.id, d.label, ...d.cells]);
			}
		}
		if (deltaTable.length > 1) {
			lines.push("Δ torus − stock (medians) vs run-to-run noise:", "", renderTable(deltaTable), "");
		}
	}

	const malformed = records.reduce((a, r) => a + (r.aggregate?.malformed ?? 0), 0);
	if (malformed > 0) {
		lines.push(`Skipped ${malformed} malformed event line(s) — counted, never fatal.`);
	}
	const failed = records.filter((r) => !r.ok);
	if (failed.length > 0) {
		lines.push(`${failed.length} run(s) failed:`);
		for (const rec of failed) {
			const tail =
				String(rec.stderr ?? "")
					.trim()
					.split("\n")
					.slice(-1)[0] ?? "";
			lines.push(
				`- ${rec.model}/${rec.taskId}/${rec.config} run ${rec.run}${rec.warmup ? " (warmup)" : ""}: ${rec.failure}${tail ? ` — ${tail}` : ""}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}

const escapeHtml = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

/**
 * One horizontal grouped-bar SVG for a field: per task, a stock bar and a
 * torus bar (median length, IQR whisker, value label), scaled against the
 * largest median across both configs. Zero-max fields render an empty chart
 * with a note.
 */
function chartSvg(field, taskRows, maxByField) {
	const width = 780;
	const labelW = 190;
	const valueW = 150;
	const trackW = width - labelW - valueW;
	const rowH = 46;
	const barH = 15;
	const legendH = 26;
	const height = legendH + taskRows.length * rowH + 6;
	const max = maxByField;
	const scale = (v) => (max <= 0 ? 0 : Math.max(0, Math.min(1, v / max)) * trackW);
	const parts = [
		`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(field.label)} by task">`,
	];
	const barClass = { stock: "bar-stock", torus: "bar-torus" };
	let x = labelW;
	const legendY = 14;
	for (const cfg of ["stock", "torus"]) {
		parts.push(
			`<rect x="${x}" y="${legendY - 9}" width="10" height="10" rx="2" class="${barClass[cfg]}"/>` +
				`<text x="${x + 15}" y="${legendY}" font-size="11" class="chart-muted">${cfg}</text>`,
		);
		x += 15 + cfg.length * 6.6 + 18;
	}
	taskRows.forEach((row, i) => {
		const y = legendH + i * rowH;
		parts.push(
			`<text x="${labelW - 12}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" class="chart-label">${escapeHtml(row.taskId)}</text>`,
		);
		for (const [j, cfg] of ["stock", "torus"].entries()) {
			const c = row.perConfig[cfg];
			const by = y + 6 + j * (barH + 4);
			if (!c || c.okCount === 0) {
				parts.push(
					`<text x="${labelW + 4}" y="${by + 12}" font-size="11" class="chart-muted">failed</text>`,
				);
				continue;
			}
			const s = c.fields[field.key];
			const barW = Math.max(scale(s.med), s.med > 0 ? 2 : 0);
			parts.push(
				`<rect x="${labelW}" y="${by}" width="${barW}" height="${barH}" rx="3" class="${barClass[cfg]}"/>`,
			);
			if (s.n >= 2 && s.iqr > 0) {
				const w1 = labelW + scale(s.p25);
				const w2 = labelW + scale(s.p75);
				parts.push(
					`<line x1="${w1}" y1="${by}" x2="${w1}" y2="${by + barH}" class="whisker" stroke-width="1"/>` +
						`<line x1="${w2}" y1="${by}" x2="${w2}" y2="${by + barH}" class="whisker" stroke-width="1"/>`,
				);
			}
			const spread = s.n >= 2 && s.iqr > 0 ? ` ±${field.fmt(s.iqr / 2)}` : "";
			parts.push(
				`<text x="${labelW + barW + 8}" y="${by + 12}" font-size="11" class="chart-label">${escapeHtml(field.fmt(s.med) + spread)}</text>`,
			);
		}
	});
	parts.push("</svg>");
	return parts.join("");
}

const METHOD_HTML = `
<h2>Method</h2>
<ol>
<li><strong>Fixed, read-only, repo-local task set</strong> in three difficulty tiers (trivial / aggregate / reason); identical prompts run through both configs, so any delta comes from the harness layer.</li>
<li><strong>Two configs</strong>: stock (bare engine, JSON mode) vs torus (same argv plus the canonical child extension set — byte-for-byte the spawn a delegation receives).</li>
<li><strong>Warmup discarded</strong>: one warmup run per task × config runs first and is excluded from statistics (steady-state prompt cache, warm extension load path).</li>
<li><strong>Interleaved rotation</strong>: measured passes alternate config order (stock, torus / torus, stock / …) so provider-side prompt-cache drift cancels across configs.</li>
<li><strong>Medians with spread</strong>: cells are medians ± half the interquartile range over measured runs; a delta is labeled <em>signal</em> only when it exceeds the larger config's IQR.</li>
<li><strong>Shared reducer</strong>: usage and cost fold out of the JSON event stream via the production <code>reduceEngineEvent</code> pipeline.</li>
</ol>
<p><strong>Caveats.</strong> Cache read/write deltas remain indicative: provider prompt caches can survive between runs, and torus's larger declaration surface inflates fresh-cache writes by construction. Tokens-in and cost deltas are the stable signals. Wall-clock includes extension loading at spawn. Numbers are self-reported by the engine per run.</p>`;

/**
 * Self-contained HTML report: metadata header, per-model SVG distribution
 * charts for every field, delta-vs-noise tables, method block. No external
 * assets — every style and chart is inline.
 * @param {ReturnType<typeof rollupRecords>} rollup
 * @param {Record<string, unknown>} meta
 * @param {Array<Record<string, unknown>>} records
 */
export function buildHtml(rollup, meta, records) {
	const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>torus overhead bench</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #111827; --fg-muted: #6b7280; --border: #e5e7eb; --rule: #9ca3af;
  --stock: #8a94a6; --torus: #3b82f6; --fail: #b91c1c;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b0f19; --fg: #e5e7eb; --fg-muted: #9ca3af; --border: #374151; --rule: #6b7280;
             --stock: #9aa4b2; --torus: #60a5fa; --fail: #f87171; }
}
body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 860px; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg); }
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.15rem; margin-top: 2.25rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; font-size: 0.85rem; color: var(--fg-muted); margin: 0 0 1.5rem; }
dl.meta dt { font-weight: 600; }
dl.meta dd { margin: 0; font-variant-ligatures: none; }
svg { width: 100%; height: auto; display: block; margin: 0.25rem 0 1rem; }
svg text { fill: currentColor; }
.chart-muted { fill: var(--fg-muted); }
.bar-stock { fill: var(--stock); }
.bar-torus { fill: var(--torus); }
.whisker { stroke: currentColor; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 0.85rem; margin: 0.5rem 0 1.5rem; }
th, td { padding: 0.25rem 0.6rem; text-align: right; border-bottom: 1px solid var(--border); }
th:first-child, td:first-child { text-align: left; }
thead th { border-bottom: 2px solid var(--rule); }
.verdict-signal { font-weight: 600; }
.fail { color: var(--fail); }
footer { margin-top: 3rem; font-size: 0.8rem; color: var(--fg-muted); }
</style>
</head>
<body>
<h1>torus overhead bench</h1>
<dl class="meta">
<dt>Generated</dt><dd>${escapeHtml(String(meta.generatedAt))}</dd>
<dt>Model(s)</dt><dd>${escapeHtml(meta.models.join(", "))}</dd>
<dt>Engine</dt><dd><code>${escapeHtml(String(meta.engineBin))}</code> (pin ${escapeHtml(String(meta.enginePin))})</dd>
<dt>torus</dt><dd>${escapeHtml(String(meta.torusVersion))} @ commit <code>${escapeHtml(String(meta.commit))}</code></dd>
<dt>Runs</dt><dd>${escapeHtml(String(meta.runs))} measured per task × config, ${escapeHtml(String(meta.warmup))} warmup discarded, config order rotated per pass</dd>
</dl>`;

	const body = [];
	for (const m of rollup) {
		body.push(`<h2>${escapeHtml(m.model)}</h2>`);
		const taskRows = m.tasks.map((t) => ({
			taskId: t.task.id,
			perConfig: t.perConfig,
		}));
		for (const f of FIELDS) {
			const max = Math.max(
				0,
				...taskRows.flatMap((r) =>
					Object.values(r.perConfig).map((c) => (c.okCount > 0 ? c.fields[f.key].med : 0)),
				),
			);
			body.push(`<h3>${f.label}</h3>`);
			body.push(chartSvg(f, taskRows, max));
		}
		const deltaTable = [
			`<h3>Δ torus − stock vs noise</h3><table><thead><tr><th>task</th><th>field</th><th>Δ med</th><th>noise (IQR)</th><th>verdict</th></tr></thead><tbody>`,
		];
		for (const t of m.tasks) {
			for (const d of deltaRows(t.perConfig, Number(meta.runs ?? 1))) {
				const cls = d.verdict === "signal" ? ' class="verdict-signal"' : "";
				deltaTable.push(
					`<tr><td>${escapeHtml(t.task.id)}</td><td>${escapeHtml(d.label)}</td><td>${escapeHtml(d.cells[0])}</td><td>${escapeHtml(d.cells[1])}</td><td${cls}>${escapeHtml(d.cells[2])}</td></tr>`,
				);
			}
		}
		deltaTable.push("</tbody></table>");
		if (deltaTable.length > 2) body.push(deltaTable.join(""));
	}
	const failed = records.filter((r) => !r.ok);
	const failures = failed.length
		? `<h2>Failures</h2><ul>${failed
				.map(
					(r) =>
						`<li class="fail">${escapeHtml(String(r.model))}/${escapeHtml(String(r.taskId))}/${escapeHtml(String(r.config))} run ${escapeHtml(String(r.run))}${r.warmup ? " (warmup)" : ""}: ${escapeHtml(String(r.failure))}</li>`,
				)
				.join("")}</ul>`
		: "";
	return `${head}${body.join("\n")}${METHOD_HTML}${failures}<footer>Self-contained report — no external assets. Raw per-run records ship in the JSON sidecar.</footer></body></html>`;
}

/**
 * JSON sidecar: meta plus every run record (warmups included), exactly as
 * executed, so the published numbers stay auditable and re-renderable
 * without re-spending tokens.
 * @param {Record<string, unknown>} meta
 * @param {Array<Record<string, unknown>>} records
 */
export function buildJson(meta, records) {
	return `${JSON.stringify({ meta, records }, null, 2)}\n`;
}
