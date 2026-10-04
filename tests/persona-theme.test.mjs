import assert from "node:assert/strict";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";

const { applyPersonaTheme } = await import("../extensions/persona-theme.ts");
const { personaFg } = await import("../extensions/ui/index.ts");

const realTheme = new Theme(
	{ muted: "#888888", text: "#ffffff", thinkingXhigh: "#aaaaaa" },
	{ selectedBg: "#222222" },
	"dark",
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function makeUi() {
	const calls = [];
	let current = { live: "plain-object reconstruction" };
	return {
		calls,
		ctx: {
			ui: {
				get theme() {
					return current;
				},
				getTheme: (_name) => realTheme,
				setTheme: (t) => {
					current = t;
					calls.push(t);
					return { success: true };
				},
			},
		},
	};
}

test("persona theme applies on the next macrotask as a real-Theme override", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, "builder");
	// Synchronous window: the engine's post-rebind applyFromSettings still runs
	// here — nothing may be applied yet.
	assert.equal(calls.length, 0);
	await tick();
	assert.equal(calls.length, 1);
	const override = calls[0];
	assert.ok(override instanceof Theme);
	assert.equal(override.getThinkingBorderColor("thinking")("hello"), personaFg("builder", "hello"));
});

test("deferred apply lands after the engine's settings-theme reset (resume clobber)", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, "reviewer");
	// Simulate themeController.applyFromSettings() firing synchronously after
	// session_start handlers return — the /resume, /new, /fork, /reload path.
	ctx.ui.setTheme(realTheme);
	assert.equal(calls.length, 1);
	await tick();
	assert.equal(calls.length, 2);
	assert.ok(calls[1] instanceof Theme);
	assert.notEqual(calls[1], realTheme);
	assert.equal(calls[1].getThinkingBorderColor("thinking")("x"), personaFg("reviewer", "x"));
});

test("persona null restores the real base theme, deferred", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, null);
	assert.equal(calls.length, 0);
	await tick();
	assert.equal(calls.length, 1);
	assert.equal(calls[0], realTheme);
});

test("rapid persona switches keep last-call-wins order (timer FIFO)", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, "builder");
	applyPersonaTheme(ctx, "looker");
	await tick();
	assert.equal(calls.length, 2);
	assert.equal(calls[1].getThinkingBorderColor("thinking")("x"), personaFg("looker", "x"));
});
