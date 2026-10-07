import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Overhead bench aggregation — pure unit tests over fixture event lines only:
// no engine spawn, no network. The bench's aggregateRuns must fold fixtures
// through the SAME reduceEngineEvent pipeline production consumes, so parity
// with the reducer is asserted directly; malformed lines are skipped and
// counted, never fatal; buildArgs must reproduce the exact spawn contract.

const { childExtensionArgs, reduceEngineEvent } = await import("../extensions/engine-child.ts");
const { TASKS, aggregateRuns, buildArgs, buildReport, computeDelta, meanAggregate, renderTable } =
	await import("../scripts/bench-overhead.lib.mjs");

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

test("task set is fixed: three read-only repo-local prompts with unique ids", () => {
	assert.equal(TASKS.length, 3);
	assert.equal(new Set(TASKS.map((t) => t.id)).size, 3);
	for (const task of TASKS) {
		assert.ok(task.prompt.length > 20, `task ${task.id} prompt looks wrong`);
		assert.ok(task.prompt.includes("Do not modify"), `task ${task.id} must be read-only`);
	}
});

test("aggregateRuns matches reduceEngineEvent folded over the same fixtures", () => {
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
	const got = aggregateRuns(lines);
	assert.equal(got.turns, expected.turns);
	assert.equal(got.tokensIn, expected.tokensIn);
	assert.equal(got.tokensOut, expected.tokensOut);
	assert.equal(got.cacheRead, expected.cacheRead);
	assert.equal(got.cacheWrite, expected.cacheWrite);
	assert.ok(Math.abs(got.cost - expected.cost) < 1e-12);
	assert.deepEqual(
		[got.turns, got.tokensIn, got.tokensOut, got.cacheRead, got.cacheWrite],
		[2, 2100, 120, 5000, 300],
	);
	assert.ok(Math.abs(got.cost - 0.003) < 1e-9, "engine cost objects sum by their total");
	assert.equal(got.malformed, 0);
});

test("aggregateRuns skips malformed lines and counts them, totals from valid lines only", () => {
	const lines = [
		messageEnd(USAGE_A),
		'{type":"message_end","message":{', // truncated JSON
		messageEnd(USAGE_B),
		"totally not json",
	];
	const got = aggregateRuns(lines);
	assert.equal(got.malformed, 2);
	assert.deepEqual([got.turns, got.tokensIn, got.tokensOut], [2, 2100, 120]);
	assert.ok(Math.abs(got.cost - 0.003) < 1e-9);
});

test("aggregateRuns treats JSON non-objects as malformed and absent usage as zero", () => {
	const got = aggregateRuns(['"a bare string"', "42", messageEnd({}, "no usage")]);
	assert.equal(got.malformed, 2);
	assert.deepEqual(
		[got.turns, got.tokensIn, got.tokensOut, got.cacheRead, got.cacheWrite, got.cost],
		[1, 0, 0, 0, 0, 0],
	);
});

test("computeDelta is the field-wise torus − stock subtraction", () => {
	const stock = {
		turns: 2,
		tokensIn: 2100,
		tokensOut: 120,
		cacheRead: 5000,
		cacheWrite: 300,
		cost: 0.003,
	};
	const torus = {
		turns: 3,
		tokensIn: 5400,
		tokensOut: 150,
		cacheRead: 5000,
		cacheWrite: 4100,
		cost: 0.0075,
	};
	assert.deepEqual(computeDelta(torus, stock), {
		turns: 1,
		tokensIn: 3300,
		tokensOut: 30,
		cacheRead: 0,
		cacheWrite: 3800,
		cost: 0.0045,
	});
});

test("meanAggregate averages each field and folds empty input to zeros", () => {
	const a = {
		turns: 2,
		tokensIn: 2100,
		tokensOut: 120,
		cacheRead: 5000,
		cacheWrite: 300,
		cost: 0.003,
	};
	const b = {
		turns: 4,
		tokensIn: 900,
		tokensOut: 40,
		cacheRead: 1000,
		cacheWrite: 100,
		cost: 0.001,
	};
	const mean = meanAggregate([a, b]);
	assert.deepEqual(mean, {
		turns: 3,
		tokensIn: 1500,
		tokensOut: 80,
		cacheRead: 3000,
		cacheWrite: 200,
		cost: 0.002,
	});
	assert.deepEqual(meanAggregate([]), {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	});
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
	assert.match(lines[1], /^\|[-:| ]+\|$/, "second line is the alignment separator");
	for (const line of lines) {
		assert.ok(line.startsWith("|") && line.endsWith("|"));
		assert.equal(line.split("|").length - 2, 4, "every row carries exactly 4 cells");
	}
	assert.ok(lines[2].includes("readme"));
	assert.ok(lines[3].includes("+$0.0011"));
	assert.equal(renderTable([]), "");
});

test("buildReport folds per-run records into per-task, delta, and totals rows with no NaN", () => {
	const rec = (config, aggregate, ms, ok = true) => ({
		taskId: "readme-name",
		config,
		run: 1,
		ok,
		ms,
		aggregate,
		stderr: "",
		failure: ok ? "" : "exit 3",
	});
	const stockAgg = aggregateRuns([messageEnd(USAGE_A)]);
	const torusAgg = aggregateRuns([messageEnd(USAGE_B)]);
	const report = buildReport(
		[
			rec("stock", stockAgg, 4000),
			rec("torus", torusAgg, 5000),
			{ ...rec("torus", stockAgg, 1000, false), run: 2 },
		],
		{
			tasks: [{ id: "readme-name", prompt: "p" }],
			configs: ["stock", "torus"],
			model: "m",
			runsLabel: "1",
			engineBin: "pi",
		},
	);
	assert.ok(!report.includes("NaN"), "per-run records must fold through their nested aggregate");
	assert.ok(/\| readme-name +\| +stock +\|/.test(report), "stock row present");
	assert.ok(report.includes("Δ torus−stock"), "delta row present");
	assert.ok(report.includes("| totals"), "totals row present");
	assert.ok(report.includes("1 run(s) failed:"), "failed runs land in the footnote");
	assert.ok(report.includes("+1,000"), "delta ms is meanMs(torus) − meanMs(stock)");
});
