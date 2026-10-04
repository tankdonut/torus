import assert from "node:assert/strict";
import { test } from "node:test";

const { registerAsk } = await import("../extensions/ask/index.ts");

function captureTool() {
	const captured = { tool: null };
	const pi = {
		on() {
			return () => {};
		},
		registerTool(tool) {
			captured.tool = tool;
		},
	};
	registerAsk(pi);
	return captured;
}

function fakeCtx({ selectScript, inputScript, hasUI = true } = {}) {
	const calls = { select: [], input: [] };
	let selectIndex = 0;
	let inputIndex = 0;
	return {
		calls,
		hasUI,
		ui: {
			async select(title, labels) {
				calls.select.push({ title, labels });
				const answer = selectScript?.[selectIndex++];
				return answer === undefined ? undefined : answer;
			},
			async input(title) {
				calls.input.push({ title });
				const answer = inputScript?.[inputIndex++];
				return answer === undefined ? undefined : answer;
			},
		},
	};
}

const PARAMS = {
	questions: [
		{
			question: "Which DB?",
			header: "db",
			options: [{ label: "postgres" }, { label: "sqlite" }],
		},
	],
};

async function run(tool, params, ctx) {
	return tool.execute("tc1", params, undefined, undefined, ctx);
}

test("torus_ask: plain select records the chosen label", async () => {
	const { tool } = captureTool();
	const ctx = fakeCtx({ selectScript: ["postgres"] });
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: postgres");
	assert.deepEqual(ctx.calls.select[0].labels, ["postgres", "sqlite"]);
});

test("torus_ask: allowCustom adds Custom… and records typed text verbatim", async () => {
	const { tool } = captureTool();
	const ctx = fakeCtx({
		selectScript: ["Custom…"],
		inputScript: ["  run MySQL on port 3307  "],
	});
	const params = {
		questions: [{ ...PARAMS.questions[0], allowCustom: true }],
	};
	const result = await run(tool, params, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: run MySQL on port 3307");
	assert.deepEqual(ctx.calls.select[0].labels, ["postgres", "sqlite", "Custom…"]);
});

test("torus_ask: custom cancelled or empty falls back to unanswered", async () => {
	const { tool } = captureTool();
	for (const typed of [undefined, "   "]) {
		const ctx = fakeCtx({ selectScript: ["Custom…"], inputScript: [typed] });
		const params = {
			questions: [{ ...PARAMS.questions[0], allowCustom: true }],
		};
		const result = await run(tool, params, ctx);
		assert.equal(result.details.mode, "fallback");
		assert.match(result.content[0].text, /not answered/);
	}
});

test("torus_ask: dismissed select and no-UI contexts use the fallback path", async () => {
	const { tool } = captureTool();
	const dismissed = fakeCtx({ selectScript: [undefined] });
	const dismissedResult = await run(tool, PARAMS, dismissed);
	assert.equal(dismissedResult.details.mode, "fallback");

	const headless = fakeCtx({ hasUI: false });
	const headlessResult = await run(tool, PARAMS, headless);
	assert.equal(headlessResult.details.mode, "fallback");
	assert.match(headlessResult.content[0].text, /options: postgres \| sqlite/);
	assert.equal(headless.calls.select.length, 0);
});
