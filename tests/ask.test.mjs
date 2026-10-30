import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, renderFakeCursor } from "@earendil-works/pi-tui";

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
	return new AskDialog(tui, theme, () => {}, { questions: spec.questions ?? [spec] });
}

test("AskDialog: input mode draws an active full-width cursor block", () => {
	const dialog = makeDialog({
		header: "db",
		question: "Which DB?",
		options: [{ label: "postgres" }],
	});
	dialog.handleInput("\t");
	dialog.handleInput("h");
	const line = dialog.render(60).find((l) => l.includes("custom answer"));
	assert.ok(line, "input line is rendered");
	assert.ok(
		line.endsWith(CURSOR_MARKER + renderFakeCursor(" ")),
		"cursor is the marked, full-width block the TUI blinks",
	);
});

function dialogWith(spec) {
	let result;
	const tui = { requestRender() {} };
	const theme = { fg: (_t, s) => s, style: (s) => s, colors: {} };
	const dialog = new AskDialog(
		tui,
		theme,
		(r) => {
			result = r;
		},
		{ questions: spec.questions ?? [spec] },
	);
	return { dialog, getResult: () => result };
}

function click(x, y) {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

const TWO_QUESTIONS = {
	questions: [
		{ question: "Which DB?", header: "db", options: [{ label: "postgres" }, { label: "sqlite" }] },
		{
			question: "When to migrate?",
			header: "timing",
			options: [{ label: "now" }, { label: "later" }],
		},
	],
};

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

test("AskDialog: multi-question dialog renders a stepper; single hides it", () => {
	const multi = makeDialog(TWO_QUESTIONS);
	const lines = multi.render(80).join("\n");
	assert.match(lines, /1 db/);
	assert.match(lines, /2 timing/);
	assert.match(lines, /←→\/hl questions/);

	const single = makeDialog(TWO_QUESTIONS.questions[0]);
	const singleLines = single.render(80);
	assert.doesNotMatch(singleLines.join("\n"), /←→\/hl questions/);
	assert.match(singleLines[1], /db — Which DB\?/);
});

test("AskDialog: arrow navigation revisits and revises earlier answers", () => {
	const { dialog, getResult } = dialogWith(TWO_QUESTIONS);
	dialog.render(80);
	dialog.handleInput("\r"); // q1: postgres, advance to q2
	assert.match(dialog.render(80).join("\n"), /timing — When to migrate\?/);
	dialog.handleInput("\x1b[D"); // left: back to q1
	const back = dialog.render(80).join("\n");
	assert.match(back, /db — Which DB\?/);
	assert.match(back, /postgres ✓/);
	dialog.handleInput("2"); // q1 revised to sqlite, advance to q2
	dialog.handleInput("\r"); // q2: now, submit
	const result = getResult();
	assert.equal(result.kind, "submit");
	assert.deepEqual(
		result.answers.map((a) => a?.text),
		["sqlite", "now"],
	);
});

test("AskDialog: clicking a stepper tab jumps to that question", () => {
	const { dialog } = dialogWith(TWO_QUESTIONS);
	const lines = dialog.render(80);
	const col = lines[1].indexOf("2 timing");
	dialog.handleMouse(click(col, 1));
	assert.match(dialog.render(80).join("\n"), /timing — When to migrate\?/);
});

test("AskDialog: clicking an option row commits it", () => {
	const { dialog, getResult } = dialogWith(TWO_QUESTIONS);
	dialog.render(80);
	dialog.handleMouse(click(0, 5)); // q1 row 0: postgres, advance
	assert.match(dialog.render(80).join("\n"), /timing — When to migrate\?/);
	dialog.render(80);
	dialog.handleMouse(click(0, 6)); // q2 row 1: later, submit
	const result = getResult();
	assert.equal(result.kind, "submit");
	assert.deepEqual(
		result.answers.map((a) => a?.text),
		["postgres", "later"],
	);
});

test("torus_ask TUI: multiple questions answer in one dialog and submit together", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("1"); // q1: postgres, advance
		dialog.handleInput("2"); // q2: later, submit
	});
	const result = await run(tool, { questions: TWO_QUESTIONS.questions }, ctx);
	assert.equal(result.details.mode, "interactive");
	assert.equal(result.content[0].text, "db: postgres\ntiming: later");
	assert.equal(ctx.calls.custom.length, 1);
});

test("torus_ask TUI: navigating past a question leaves it unanswered", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("\x1b[C"); // right without answering q1
		dialog.handleInput("1"); // q2: now, submit
	});
	const result = await run(tool, { questions: TWO_QUESTIONS.questions }, ctx);
	assert.equal(result.details.mode, "fallback");
	assert.match(result.content[0].text, /answered: timing: now/);
	assert.match(result.content[0].text, /- db: Which DB\?/);
});

test("torus_ask TUI: chat mid-dialog keeps earlier answers", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("1"); // q1: postgres, advance
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r"); // q2: chat row
	});
	const result = await run(tool, { questions: TWO_QUESTIONS.questions }, ctx);
	assert.equal(result.details.mode, "chat");
	assert.match(result.content[0].text, /already answered:/);
	assert.match(result.content[0].text, /- db: postgres/);
	assert.match(result.content[0].text, /- timing: When to migrate\?/);
});

test("torus_ask TUI: escape cancels the whole dialog", async () => {
	const { tool } = captureTool();
	const ctx = tuiCtx((dialog) => {
		dialog.handleInput("1"); // q1: postgres, advance
		dialog.handleInput("\x1b"); // cancel on q2
	});
	const result = await run(tool, { questions: TWO_QUESTIONS.questions }, ctx);
	assert.equal(result.details.mode, "fallback");
	assert.match(result.content[0].text, /- db: Which DB\?/);
	assert.match(result.content[0].text, /- timing: When to migrate\?/);
});
