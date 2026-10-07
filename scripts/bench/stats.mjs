// Pure statistics + scheduling for the bench. No engine spawns, no fs, no
// network — every function here is unit-testable with plain numbers.

/**
 * Linear-interpolated quantile of a numeric sample (0..1). Sorting is done on
 * a copy; empty input folds to 0 so report cells can never go NaN.
 * @param {number[]} values
 * @param {number} q
 */
export function quantile(values, q) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** @param {number[]} values */
export function median(values) {
	return quantile(values, 0.5);
}

/**
 * Summary of a numeric sample: median, quartile spread, extremes.
 * @param {number[]} values
 */
export function summarize(values) {
	const p25 = quantile(values, 0.25);
	const p75 = quantile(values, 0.75);
	return {
		n: values.length,
		med: quantile(values, 0.5),
		p25,
		p75,
		min: values.length === 0 ? 0 : Math.min(...values),
		max: values.length === 0 ? 0 : Math.max(...values),
		iqr: p75 - p25,
	};
}

/**
 * Verdict for a delta given observed run-to-run noise:
 * - "signal" — |Δmedian| exceeds the larger config's interquartile range, so
 *   the delta is distinguishable from run-to-run jitter;
 * - "noise" — within jitter, report the number but not the conclusion;
 * - "flat" — both median delta and spread are exactly zero;
 * - null — fewer than two measured runs, so there is no dispersion basis and
 *   any verdict would overclaim.
 * @param {number} deltaMed
 * @param {number} noiseIqr
 * @param {number} measuredRuns
 * @returns {"signal" | "noise" | "flat" | null}
 */
export function classifySignal(deltaMed, noiseIqr, measuredRuns) {
	if (measuredRuns < 2) return null;
	if (deltaMed === 0 && noiseIqr <= 0) return "flat";
	if (Math.abs(deltaMed) > noiseIqr) return "signal";
	return "noise";
}

/**
 * Interleaved execution plan: per task, warmup runs first (configs in listed
 * order, discarded from stats), then measured runs where each pass rotates the
 * config order (AB, BA, AB, ...) so provider-side prompt-cache drift and any
 * slow warming trend cancel across configs instead of confounding the delta.
 *
 * Warmup records carry run: 0 and warmup: true; measured runs are numbered
 * from 1.
 * @param {ReadonlyArray<{id: string}>} tasks
 * @param {string[]} configs
 * @param {number} measuredRuns
 * @param {number} warmupRuns
 */
export function buildSchedule(tasks, configs, measuredRuns, warmupRuns) {
	const plan = [];
	for (const task of tasks) {
		for (let w = 0; w < warmupRuns; w++) {
			for (const config of configs) {
				plan.push({ taskId: task.id, config, run: 0, warmup: true });
			}
		}
		for (let r = 0; r < measuredRuns; r++) {
			for (let i = 0; i < configs.length; i++) {
				const config = configs[(i + r) % configs.length];
				plan.push({ taskId: task.id, config, run: r + 1, warmup: false });
			}
		}
	}
	return plan;
}
