import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Bench framework — pure unit tests over fixtures only: no engine spawn, no
// model API. Aggregation must fold through the SAME reduceEngineEvent
// pipeline production consumes (parity asserted directly); scheduling,
// statistics, verdicts, and all three report renderers are exercised on
// hand-computed inputs. The one spawn test uses node itself, never the
// engine, and never the network.

const { childExtensionArgs, reduceEngineEvent } = await import("../extensions/engine-child.ts");
const { READ_ONLY_GUARD, TASKS, selectTasks } = await import("../scripts/bench/tasks.mjs");
const { buildSchedule, classifySignal, median, quantile, summarize } = await import(
	"../scripts/bench/stats.mjs"
);
const { aggregateEventLines, buildArgs, runEngineOnce } = await import(
	"../scripts/bench/engine-run.mjs"
);
const {
	buildHtml,
	buildJson,
	buildMarkdown,
	deltaRows,
	engineBinLabel,
	fieldValue,
	FIELDS,
	renderTable,
	rollupRecords,
} = await import("../scripts/bench/report.mjs");

const messageEnd = (usage, text = "done") =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage,
		},
	});

const USAGE_A = {
	input: 1200,
	output: 80,
	cacheRead: 5000,
	cacheWrite: 300,
	cost: { total: 0.0021 },
};
const USAGE_B = { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0009 } };

test("task suite: six tiered read-only tasks with unique ids and the guard sentence", () => {
	assert.equal(TASKS.length, 6);
	assert.deepEqual([...new Set(TASKS.map((t) => t.id))].length, 6);
	assert.deepEqual(new Set(TASKS.map((t) => t.tier)), new Set(["trivial", "aggregate", "reason"]));
	for (const task of TASKS) {
		assert.ok(task.prompt.length > 20, `task ${task.id} prompt looks wrong`);
		assert.ok(task.prompt.endsWith(READ_ONLY_GUARD), `task ${task.id} must end with the guard`);
	}
});

test("selectTasks: empty selector returns the full suite; unknown ids fail loud", () => {
	assert.equal(selectTasks("  ").length, TASKS.length);
	const picked = selectTasks("readme-name, skills-inventory");
	assert.deepEqual(
		picked.map((t) => t.id),
		["readme-name", "skills-inventory"],
	);
	assert.throws(() => selectTasks("readme-name, nope"), /unknown task id: nope/);
});

test("buildArgs: stock is the bare JSON-mode argv; torus appends the canonical child extension args", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-bench-args-"));
	const prompt = "Read README.md and state the project name.";
	const stock = buildArgs("stock", "zai/glm-5.3-flash", prompt, root);
	assert.deepEqual(stock, ["--mode", "json", "--model", "zai/glm-5.3-flash", "-p", prompt]);
	assert.deepEqual(buildArgs("torus", "zai/glm-5.3-flash", prompt, root), [
		...stock,
		...childExtensionArgs(root),
	]);
	assert.throws(
		() => buildArgs("bogus", "zai/glm-5.3-flash", prompt, root),
		/unknown bench config/,
	);
});

test("aggregateEventLines matches reduceEngineEvent folded over the same fixtures", () => {
	const lines = [
		JSON.stringify({ type: "session", id: "s-bench" }),
		messageEnd(USAGE_A, "first turn"),
		JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
		messageEnd(USAGE_B, "second turn"),
	];
	const expected = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
	};
	for (const line of lines) {
		reduceEngineEvent(JSON.parse(line), expected);
	}
	const got = aggregateEventLines(lines);
	assert.equal(got.turns, expected.turns);
	assert.equal(got.tokensIn, expected.tokensIn);
	assert.deepEqual(
		[got.turns, got.tokensIn, got.tokensOut, got.cacheRead, got.cacheWrite],
		[2, 2100, 120, 5000, 300],
	);
	assert.ok(Math.abs(got.cost - 0.003) < 1e-9, "engine cost objects sum by their total");
	assert.equal(got.malformed, 0);
});

test("aggregateEventLines skips malformed lines, counts them, totals valid lines only", () => {
	const got = aggregateEventLines([
		messageEnd(USAGE_A),
		'{type":"message_end","message":{',
		messageEnd(USAGE_B),
		"totally not json",
		'"a bare string"',
		"42",
	]);
	assert.equal(got.malformed, 4);
	assert.deepEqual([got.turns, got.tokensIn, got.tokensOut], [2, 2100, 120]);
	assert.ok(Math.abs(got.cost - 0.003) < 1e-9);
});

test("aggregateEventLines treats absent usage as zero", () => {
	const got = aggregateEventLines([messageEnd({}, "no usage")]);
	assert.deepEqual(
		[got.turns, got.tokensIn, got.tokensOut, got.cacheRead, got.cacheWrite, got.cost],
		[1, 0, 0, 0, 0, 0],
	);
});

test("quantile/median: linear interpolation, sorting copy, empty folds to 0", () => {
	assert.equal(quantile([1, 2, 3, 4], 0), 1);
	assert.equal(quantile([1, 2, 3, 4], 1), 4);
	assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
	assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
	assert.equal(median([30, 10, 20]), 20);
	assert.equal(quantile([], 0.5), 0);
	const input = [3, 1, 2];
	quantile(input, 0.5);
	assert.deepEqual(input, [3, 1, 2], "caller's array must not be reordered");
});

test("summarize: quartiles, IQR, extremes; empty sample folds to zeros", () => {
	assert.deepEqual(summarize([10, 20, 30]), {
		n: 3,
		med: 20,
		p25: 15,
		p75: 25,
		min: 10,
		max: 30,
		iqr: 10,
	});
	assert.deepEqual(summarize([]), {
		n: 0,
		med: 0,
		p25: 0,
		p75: 0,
		min: 0,
		max: 0,
		iqr: 0,
	});
});

test("classifySignal: signal/within-noise/flat, null when no dispersion basis", () => {
	assert.equal(classifySignal(100, 50, 3), "signal");
	assert.equal(classifySignal(30, 50, 3), "noise");
	assert.equal(classifySignal(50, 50, 3), "noise", "delta equal to noise stays within noise");
	assert.equal(classifySignal(0, 0, 3), "flat");
	assert.equal(classifySignal(-40, 10, 2), "signal", "negative deltas can be signals too");
	assert.equal(classifySignal(100, 50, 1), null);
});

test("buildSchedule: warmups first, measured passes rotate config order", () => {
	const plan = buildSchedule([{ id: "t1" }, { id: "t2" }], ["stock", "torus"], 3, 1);
	assert.deepEqual(
		plan.map((s) => `${s.taskId}:${s.warmup ? "warm" : s.run}:${s.config}`),
		[
			"t1:warm:stock",
			"t1:warm:torus",
			"t1:1:stock",
			"t1:1:torus",
			"t1:2:torus",
			"t1:2:stock",
			"t1:3:stock",
			"t1:3:torus",
			"t2:warm:stock",
			"t2:warm:torus",
			"t2:1:stock",
			"t2:1:torus",
			"t2:2:torus",
			"t2:2:stock",
			"t2:3:stock",
			"t2:3:torus",
		],
	);
	const measured = plan.filter((s) => !s.warmup);
	assert.equal(measured.filter((s) => s.taskId === "t1" && s.config === "stock").length, 3);
	assert.equal(measured.filter((s) => s.taskId === "t2" && s.config === "torus").length, 3);
});

test("fieldValue: aggregate fields from the tally, ms from the record, missing folds to 0", () => {
	const rec = { aggregate: { tokensIn: 5, cost: 0.1 }, ms: 100 };
	assert.equal(fieldValue(rec, "tokensIn"), 5);
	assert.equal(fieldValue(rec, "cost"), 0.1);
	assert.equal(fieldValue(rec, "ms"), 100);
	assert.equal(fieldValue({ ms: 7 }, "tokensIn"), 0);
});

const rec = (over) => ({
	model: "m1",
	taskId: "t1",
	config: "stock",
	run: 1,
	warmup: false,
	ok: true,
	ms: 1000,
	aggregate: {
		turns: 2,
		tokensIn: 100,
		tokensOut: 30,
		cacheRead: 500,
		cacheWrite: 0,
		cost: 0.001,
		malformed: 0,
	},
	...over,
});

function fixtureDataset() {
	const agg = (tokensIn, cost) => ({
		turns: 2,
		tokensIn,
		tokensOut: 30,
		cacheRead: 500,
		cacheWrite: 0,
		cost,
		malformed: 0,
	});
	const stock = [100, 120, 140].map((tokensIn, i) =>
		rec({ config: "stock", run: i + 1, ms: 1000 + i * 200, aggregate: agg(tokensIn, 0.001) }),
	);
	const torusOk = [200, 240].map((tokensIn, i) =>
		rec({ config: "torus", run: i + 1, ms: 2000 + i * 400, aggregate: agg(tokensIn, 0.002) }),
	);
	const torusFailed = rec({
		config: "torus",
		run: 3,
		ok: false,
		ms: 50,
		failure: "exit 3",
		stderr: "boom",
		aggregate: agg(0, 0),
	});
	const warmups = [
		rec({ config: "stock", run: 0, warmup: true, ms: 9999 }),
		rec({
			config: "torus",
			run: 0,
			warmup: true,
			ms: 9999,
			aggregate: { ...rec().aggregate, tokensIn: 9999 },
		}),
	];
	return { stock, torusOk, torusFailed, warmups };
}

test("rollupRecords: warmups excluded, failed runs counted not averaged, summaries computed", () => {
	const { stock, torusOk, torusFailed, warmups } = fixtureDataset();
	const [model] = rollupRecords(
		[...warmups, ...stock, ...torusOk, torusFailed],
		[{ id: "t1", tier: "trivial" }],
		["stock", "torus"],
		["m1"],
	);
	const s = model.tasks[0].perConfig.stock;
	assert.equal(s.measuredRuns, 3);
	assert.equal(s.okCount, 3);
	assert.equal(s.fields.tokensIn.med, 120);
	assert.equal(s.fields.tokensIn.iqr, 20);
	const t = model.tasks[0].perConfig.torus;
	assert.equal(t.measuredRuns, 3);
	assert.equal(t.okCount, 2);
	assert.equal(t.failCount, 1);
	assert.equal(t.fields.tokensIn.med, 220, "median of [200, 240] — failed run contributes nothing");
	assert.equal(t.fields.ms.med, 2200);
});

test("deltaRows: empty unless both configs completed; deltas, noise, verdicts correct", () => {
	const { stock, torusOk } = fixtureDataset();
	const perConfig = {
		stock: rollupRecords(stock, [{ id: "t1", tier: "trivial" }], ["stock"], ["m1"])[0].tasks[0]
			.perConfig.stock,
		torus: {
			okCount: 0,
			failCount: 3,
			measuredRuns: 3,
			fields: Object.fromEntries(FIELDS.map((f) => [f.key, summarize([])])),
		},
	};
	assert.deepEqual(deltaRows(perConfig, 3), [], "stock-only-complete yields no delta rows");

	const both = rollupRecords(
		[...stock, ...torusOk],
		[{ id: "t1", tier: "trivial" }],
		["stock", "torus"],
		["m1"],
	)[0].tasks[0].perConfig;
	const rows = deltaRows(both, 2);
	const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
	assert.equal(byKey.tokensIn.delta, 100);
	assert.equal(byKey.tokensIn.noise, 20, "max IQR of the two configs");
	assert.equal(byKey.tokensIn.verdict, "signal");
	assert.equal(byKey.tokensOut.verdict, "flat", "identical constant values, zero delta and spread");
	assert.deepEqual(byKey.tokensIn.cells, ["+100", "20", "signal"]);
});

test("renderTable emits a markdown table: header, separator, rows, uniform pipe count", () => {
	const table = renderTable([
		["task", "config", "tokens in", "cost"],
		["readme", "stock", "4,210", "$0.0041"],
		["readme", "delta", "+2,680", "+$0.0011"],
	]);
	const lines = table.split("\n");
	assert.equal(lines.length, 4);
	assert.ok(lines[0].startsWith("| task "));
	assert.ok(lines[0].endsWith(" cost |"));
	assert.match(lines[1], /^\|[-:| ]+\|$/);
	for (const line of lines) {
		assert.ok(line.startsWith("|") && line.endsWith("|"));
		assert.equal(line.split("|").length - 2, 4, "every row carries exactly 4 cells");
	}
	assert.ok(lines[2].includes("readme"));
	assert.ok(lines[3].includes("+$0.0011"));
	assert.equal(renderTable([]), "");
});

test("buildMarkdown: medians with spread, delta table with verdicts, totals, failure footnote, no NaN", () => {
	const { stock, torusOk, torusFailed, warmups } = fixtureDataset();
	const records = [...warmups, ...stock, ...torusOk, torusFailed];
	const meta = {
		generatedAt: "2026-10-08T00:00:00.000Z",
		models: ["m1"],
		engineBin: "/bin/pi",
		enginePin: "1.0.4",
		torusVersion: "0.6.0",
		commit: "abc1234",
		runs: 3,
		warmup: 1,
		taskCount: 1,
	};
	const rollup = rollupRecords(
		records,
		[{ id: "t1", tier: "trivial" }],
		["stock", "torus"],
		["m1"],
	);
	const report = buildMarkdown(rollup, meta, records);

	assert.ok(!report.includes("NaN"));
	assert.ok(report.includes("interleaved"), "method note present");
	assert.ok(/\| t1 +\| +stock +\|/.test(report), "stock row present");
	assert.ok(report.includes("220 ±10"), "median cell carries half-IQR spread");
	assert.ok(report.includes("Δ torus − stock"), "delta section present");
	assert.ok(report.includes("signal"), "verdict rendered");
	assert.ok(report.includes("+100"), "delta cell rendered with sign");
	assert.ok(report.includes("| totals"), "totals row present");
	assert.ok(report.includes("1 run(s) failed:"), "failed measured run lands in the footnote");
	assert.ok(report.includes("run 3: exit 3"), "failure carries run number and cause");
	assert.ok(!report.includes("run 0"), "warmup records never appear in the markdown");
});

test("buildHtml: self-contained report with inline SVG, meta, delta table, no external refs", () => {
	const { stock, torusOk, torusFailed, warmups } = fixtureDataset();
	const hostile = "t1<>&'";
	const records = [...warmups, ...stock, ...torusOk, torusFailed].map((r) => ({
		...r,
		taskId: hostile,
	}));
	const meta = {
		generatedAt: "2026-10-08T00:00:00.000Z",
		models: ["m1"],
		engineBin: "/bin/pi",
		enginePin: "1.0.4",
		torusVersion: "0.6.0",
		commit: 'abc"<>&1234',
		runs: 3,
		warmup: 1,
	};
	const rollup = rollupRecords(
		records,
		[{ id: hostile, tier: "trivial" }],
		["stock", "torus"],
		["m1"],
	);
	const html = buildHtml(rollup, meta, records);

	assert.ok(html.startsWith("<!doctype html>"));
	assert.ok(html.includes("t1&lt;&gt;&amp;&#39;"), "task ids are HTML-escaped");
	assert.ok((html.match(/<svg/g) ?? []).length >= FIELDS.length, "one chart per field");
	assert.ok(!html.includes("t1<>"), "raw markup never leaks");
	assert.ok(html.includes("abc&quot;&lt;&gt;&amp;1234"), "meta values are escaped");
	assert.ok(html.includes("Δ torus − stock vs noise"), "delta table present");
	assert.ok(html.includes("signal"), "verdicts rendered");
	assert.ok(html.includes("Interleaved rotation"), "method block present");
	assert.ok(!/src="http|href="http/.test(html), "no external assets");
	assert.ok(html.includes("prefers-color-scheme"), "theme adapts to dark mode");
	assert.ok(html.includes("currentColor"), "SVG text/whiskers inherit the page color");
	assert.ok(!/fill="#|stroke="#/.test(html), "no hard-coded SVG colors that break dark mode");
	assert.ok(html.endsWith("</html>"));
});

test("buildJson: meta + every record (warmups included), JSON round-trip", () => {
	const { stock, torusOk, torusFailed, warmups } = fixtureDataset();
	const records = [...warmups, ...stock, ...torusOk, torusFailed];
	const parsed = JSON.parse(buildJson({ runs: 3, models: ["m1"] }, records));
	assert.equal(parsed.meta.runs, 3);
	assert.equal(parsed.records.length, records.length);
	const warmupRecord = parsed.records.find((r) => r.warmup && r.config === "torus");
	assert.ok(warmupRecord, "warmup runs ship in the sidecar");
	assert.equal(warmupRecord.aggregate.tokensIn, 9999);
	assert.ok(parsed.records.some((r) => r.ok === false));
});

test("runEngineOnce resolves with collected lines and exit code (local node, never the engine)", async () => {
	const script = 'console.log(JSON.stringify({type:"session"}));console.log("x");';
	const result = await runEngineOnce(
		process.execPath,
		["-e", script],
		process.cwd(),
		process.env,
		10000,
	);
	assert.equal(result.exitCode, 0);
	assert.equal(result.lines.length, 2);
	assert.ok(result.lines[0].includes('"session"'));
	assert.equal(result.timedOut, false);
	assert.equal(result.spawnError, undefined);
});

test("engineBinLabel: repo-relative under root, bare basename outside, never absolute", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-bench-label-"));
	assert.equal(
		engineBinLabel(path.join(root, "node_modules", ".bin", "pi"), root),
		path.join("node_modules", ".bin", "pi"),
	);
	assert.equal(engineBinLabel("/opt/engines/pi", root), "pi");
	assert.equal(engineBinLabel(path.join(root, "..", "elsewhere", "pi"), root), "pi");
});

test("committed bench artifacts carry no machine-local absolute home paths", () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const homePath = /(\/var\/home|\/home|\/Users)\/[A-Za-z0-9_.-]+\//;
	for (const rel of ["docs/efficiency.md", "docs/efficiency.html", "docs/bench-records.json"]) {
		const content = readFileSync(path.join(root, rel), "utf8");
		assert.ok(
			!homePath.test(content),
			`${rel} leaks a machine-local home path — regenerate with a path-free engine label`,
		);
	}
});
