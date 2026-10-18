import assert from "node:assert/strict";
import { test } from "node:test";

const { registerAsk } = await import("../extensions/ask/index.ts");
const { AskDialog, CHAT_LABEL, CUSTOM_LABEL } = await import("../extensions/ask/dialog.ts");

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
		mode: "rpc",
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

function tuiCtx(drive) {
	const calls = { custom: [] };
	return {
		calls,
		mode: "tui",
		hasUI: true,
		ui: {
			custom(factory, opts) {
				calls.custom.push(opts);
				return new Promise((resolve) => {
					const tui = { requestRender() {} };
					const theme = {
						fg: (_token, s) => s,
						style: (s) => s,
						colors: {},
					};
					const component = factory(tui, theme, {}, (result) => resolve(result));
					drive(component);
				});
			},
		},
	};
}

function makeDialog(spec) {
	const tui = { requestRender() {} };
	const theme = { fg: (_t, s) => s, style: (s) => s, colors: {} };
	return new AskDialog(tui, theme, () => {}, spec);
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
	assert.deepEqual(ctx.calls.select[0].labels, ["postgres", "sqlite", CUSTOM_LABEL, CHAT_LABEL]);
});

test("torus_ask: custom answer is always available without any flag", async () => {
	const { tool } = captureTool();
	const ctx = fakeCtx({
		selectScript: [CUSTOM_LABEL],
		inputScript: ["  run MySQL on port 3307  "],
	});
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: run MySQL on port 3307 (custom)");
});

test("torus_ask: custom cancelled or empty falls back to unanswered", async () => {
	const { tool } = captureTool();
	for (const typed of [undefined, "   "]) {
		const ctx = fakeCtx({ selectScript: [CUSTOM_LABEL], inputScript: [typed] });
		const result = await run(tool, PARAMS, ctx);
		assert.equal(result.details.mode, "fallback");
		assert.match(result.content[0].text, /not answered/);
	}
});

test("torus_ask: chat row returns a discuss directive, never an approval", async () => {
	const { tool } = captureTool();
	const ctx = fakeCtx({ selectScript: [CHAT_LABEL] });
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "chat");
	assert.match(result.content[0].text, /do NOT treat this as approval/);
	assert.match(result.content[0].text, /db: Which DB\?/);
	assert.match(result.content[0].text, /re-call torus_ask/);
});

test("torus_ask: chat keeps already-given answers", async () => {
	const { tool } = captureTool();
	const ctx = fakeCtx({ selectScript: ["postgres", CHAT_LABEL] });
	const params = {
		questions: [
			PARAMS.questions[0],
			{
				question: "When to migrate?",
				header: "timing",
				options: [{ label: "now" }, { label: "later" }],
			},
		],
	};
	const result = await run(tool, params, ctx);
	assert.equal(result.details.mode, "chat");
	assert.match(result.content[0].text, /already answered:/);
	assert.match(result.content[0].text, /- db: postgres/);
	assert.match(result.content[0].text, /- timing: When to migrate\?/);
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

test("torus_ask TUI: digit keys commit an option", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => dialog.handleInput("2"));
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: sqlite");
	assert.equal(ctx.calls.custom.length, 1);
});

test("torus_ask TUI: n attaches a note to the highlighted option", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("n");
		for (const ch of "needs sudo") dialog.handleInput(ch);
		dialog.handleInput("\r");
		dialog.handleInput("\r");
	});
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: postgres (note: needs sudo)");
});

test("torus_ask TUI: tab opens the custom field and the answer is recorded", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("\t");
		for (const ch of "use neon") dialog.handleInput(ch);
		dialog.handleInput("\r");
		dialog.handleInput("\r");
	});
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: use neon (custom)");
});

test("torus_ask TUI: chat row is reachable by navigation", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
	});
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "chat");
	assert.match(result.content[0].text, /db: Which DB\?/);
});

test("torus_ask TUI: escape cancels and falls back to unanswered", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => dialog.handleInput("\x1b"));
	const result = await run(tool, PARAMS, ctx);
	assert.equal(result.details.mode, "fallback");
	assert.match(result.content[0].text, /not answered/);
});

test("AskDialog: preview pane renders the highlighted option side by side", () => {
	const spec = {
		header: "layout — pick a layout",
		question: "pick",
		options: [
			{ label: "sidebar", preview: "┌──┬──┐\n│  │  │\n└──┴──┘" },
			{ label: "stacked", preview: "┌─────┐\n├─────┤\n└─────┘" },
		],
	};
	const dialog = makeDialog(spec);
	const first = dialog.render(80).join("\n");
	assert.match(first, /sidebar/);
	assert.match(first, /┌──┬──┐/);

	dialog.handleInput("\x1b[B");
	const second = dialog.render(80).join("\n");
	assert.match(second, /┌─────┐/);
	assert.doesNotMatch(second, /┌──┬──┐/);
});

test("AskDialog: descriptions render under options without previews", () => {
	const spec = {
		header: "db",
		question: "Which DB?",
		options: [{ label: "postgres", description: "heavy but standard" }],
	};
	const lines = makeDialog(spec).render(80).join("\n");
	assert.match(lines, /postgres/);
	assert.match(lines, /heavy but standard/);
});
