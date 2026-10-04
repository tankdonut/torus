import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// FleetBrowser navigation + mouse-mode hygiene, driven through the real
// openFleet paths: FLEET_OPENER (strip click / alt+N focus open) and the
// alt+t shortcut (list open). TORUS_HOME must land before the registry
// import — it derives the logs dir at module load.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-fleet-browser-test-"));
process.env.TORUS_HOME = HOME;

const registry = await import("../extensions/registry.ts");
const browser = await import("../extensions/browser/index.ts");
const team = await import("../extensions/team/index.ts");
const fleet = await import("../extensions/fleet/index.ts");

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fleet-fake-engines-"));
const EVENT_ENGINE = path.join(ENGINE_DIR, "event-engine.sh");
writeFileSync(
	EVENT_ENGINE,
	'#!/bin/sh\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(EVENT_ENGINE, 0o755);
const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;
async function withEngine(bin, fn) {
	process.env.TORUS_ENGINE_BIN = bin;
	try {
		return await fn();
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}
}

const ESC = "\x1b";
const ENTER = "\r";
const ENABLE_WHEEL = "\x1b[?1000h\x1b[?1006h";
const DISABLE_WHEEL = "\x1b[?1006l\x1b[?1000l";

after(() => {
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

function registerExtension() {
	const shortcuts = new Map();
	const hooks = new Map();
	browser.registerBrowser({
		on: (event, handler) => hooks.set(event, handler),
		registerCommand: () => {},
		registerShortcut: (key, def) => shortcuts.set(key, def),
	});
	return { shortcuts, hooks };
}

/** A ctx whose ui.custom captures the constructed overlay. */
function makeCtx(tuiMode, theme = {}) {
	let component = null;
	let doneCalls = 0;
	return {
		ctx: {
			hasUI: true,
			ui: {
				custom(factory) {
					component = factory({ mode: tuiMode, requestRender: () => {} }, theme, undefined, () => {
						doneCalls += 1;
					});
				},
			},
		},
		component: () => component,
		doneCount: () => doneCalls,
	};
}

/** Collect everything written to stdout while fn runs. */
function captureStdout(fn) {
	const original = process.stdout.write.bind(process.stdout);
	const chunks = [];
	process.stdout.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		process.stdout.write = original;
	}
	return chunks;
}

test("fullscreen: overlay writes no mouse modes, so host clicks survive close", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-fs-1", "builder", "zai/glm-5.3", null, "fsy");
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen");
	hooks.get("session_start")(undefined, driver.ctx);
	let opened = null;
	const chunks = captureStdout(() => {
		const opener = globalThis[registry.FLEET_OPENER];
		opener("fb-fs-1");
		opened = driver.component();
		opened.dispose();
	});
	assert.ok(opened, "overlay component not constructed");
	assert.deepEqual(chunks, [], "fullscreen must not enable or disable host mouse modes");
});

test("regular mode: overlay takes over wheel reporting and restores it on dispose", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-reg-1", "builder", "zai/glm-5.3", null, "reg");
	const { shortcuts } = registerExtension();
	const driver = makeCtx("regular");
	let opened = null;
	const chunks = captureStdout(() => {
		shortcuts.get("alt+t").handler(driver.ctx);
		opened = driver.component();
		opened.dispose();
	});
	assert.ok(opened, "overlay component not constructed");
	assert.deepEqual(chunks, [ENABLE_WHEEL, DISABLE_WHEEL]);
});

test("click-opened detail: esc returns straight to the TUI, not the fleet list", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-click-1", "explorer", "zai/glm-5.3-flash", null, "clicky");
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen");
	hooks.get("session_start")(undefined, driver.ctx);
	const opener = globalThis[registry.FLEET_OPENER];
	opener("fb-click-1");
	const component = driver.component();
	component.handleInput(ESC);
	assert.equal(driver.doneCount(), 1, "esc from a click-opened detail must close the overlay");
	component.dispose();
});

test("alt+t flow: detail opened from the list still backs out to the list first", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-list-1", "builder", "zai/glm-5.3", null, "listy");
	const { shortcuts } = registerExtension();
	const driver = makeCtx("fullscreen");
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	// render() normally seeds items; ENTER requires a non-empty list.
	component.items = [{ kind: "delegation", record: registry.listDelegations()[0] }];
	component.handleInput(ENTER);
	component.handleInput(ESC);
	assert.equal(driver.doneCount(), 0, "esc from a list-visited detail must return to the list");
	component.handleInput(ESC);
	assert.equal(driver.doneCount(), 1, "second esc closes from the list");
	component.dispose();
});

test("fullscreen wheel: handleMouse scrolls the detail view by host wheelDelta", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-wheel-1", "builder", "zai/glm-5.3", null, "wheely");
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen");
	hooks.get("session_start")(undefined, driver.ctx);
	globalThis[registry.FLEET_OPENER]("fb-wheel-1");
	const component = driver.component();
	// State as renderDetail leaves it: pinned at the bottom of the transcript.
	component.detailMaxScroll = 40;
	component.scroll = 40;
	component.follow = true;
	assert.deepEqual(component.handleMouse({ type: "wheel", button: "none", y: 5, wheelDelta: -3 }), {
		handled: true,
	});
	assert.equal(component.follow, false, "wheel up must break follow");
	assert.equal(component.scroll, 37);
	assert.deepEqual(component.handleMouse({ type: "wheel", button: "none", y: 5, wheelDelta: 5 }), {
		handled: true,
	});
	assert.equal(component.scroll, 42, "render clamps the overshoot");
	assert.equal(component.follow, true, "reaching the bottom re-engages follow");
	component.dispose();
});

test("fullscreen wheel: list cursor steps by wheel direction", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-wheel-a", "builder", "zai/glm-5.3", null, "wha");
	registry.startDelegation("fb-wheel-b", "explorer", "zai/glm-5.3-flash", null, "whb");
	const { shortcuts } = registerExtension();
	const driver = makeCtx("fullscreen");
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	component.items = registry.listDelegations().map((record) => ({ kind: "delegation", record }));
	assert.deepEqual(component.handleMouse({ type: "wheel", button: "none", y: 1, wheelDelta: 3 }), {
		handled: true,
	});
	assert.equal(component.cursor, 1);
	assert.deepEqual(component.handleMouse({ type: "wheel", button: "none", y: 1, wheelDelta: -1 }), {
		handled: true,
	});
	assert.equal(component.cursor, 0);
	component.dispose();
});

test("fullscreen click: clicking a rendered list row opens its detail", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("fb-click-2", "builder", "zai/glm-5.3", null, "rowclick");
	const { shortcuts } = registerExtension();
	const driver = makeCtx(
		"fullscreen",
		// renderList draws through the theme; passthrough keeps output assertion-free.
		{ fg: (_color, text) => text, bold: (text) => text },
	);
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	component.render(100);
	assert.equal(component.mode, "list");
	// Non-row lines and non-left buttons are not consumed.
	assert.equal(component.handleMouse({ type: "click", button: "left", x: 3, y: 1 }), undefined);
	assert.equal(component.handleMouse({ type: "click", button: "right", x: 3, y: 3 }), undefined);
	assert.equal(component.mode, "list");
	// Layout is [rule, header, bar, rows...] — first delegation row is y=3.
	assert.deepEqual(component.handleMouse({ type: "click", button: "left", x: 3, y: 3 }), {
		handled: true,
	});
	assert.equal(component.mode, "detail");
	assert.equal(component.cursor, 0);
	component.dispose();
});

test("fan-out coalesces near-simultaneous completions into one combined result marker", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	registry.setCustomSender((message, options) => customs.push({ message, options }));
	const tools = [];
	team.registerTeam({ registerTool: (t) => tools.push(t) });
	const fanoutTool = tools.find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	const ctx = {
		sessionManager: { getSessionId: () => "sess-coalesce" },
		ui: { setStatus: () => {} },
	};

	await withEngine(EVENT_ENGINE, async () => {
		const result = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "probe a", handle: "alpha" },
					{ agent: "builder", task: "probe b", handle: "beta" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.ok, 2, "both runs succeed under the fake engine");
	});

	const results = customs.filter((e) => e.message.customType === "torus.delegation-result");
	assert.equal(results.length, 1, "both completions merge into exactly one result marker");
	const entry = results[0];
	assert.equal(entry.message.details.runs, 2);
	assert.equal(entry.message.details.delegationIds.length, 2, "combined marker lists every run id");
	assert.equal(entry.options?.triggerTurn, false, "combined marker defers to the turn boundary");
	registry.setCustomSender(() => {});
});

test("strip: team members show a badge + idle state; overflow row appears past MAX_ROWS", () => {
	registry.resetRegistryForTesting();
	const tui = { mode: "fullscreen", requestRender: () => {} };
	const theme = { fg: (_color, text) => text, bold: (text) => `*${text}*` };
	let factory = null;
	fleet.registerFleetWidget({
		on: (event, handler) => {
			if (event === "session_start") handler({}, { ui: { setWidget: (_key, f) => (factory = f) } });
		},
		registerShortcut: () => {},
	});
	assert.ok(factory, "widget factory captured");

	const memberId = "team-abc/scout";
	registry.startDelegation(memberId, "builder", "zai/glm-5.3-flash", "sess", "scout");
	registry.publishExternalRun({
		id: memberId,
		source: "torus-team:myteam-abc",
		label: "scout",
		handle: "scout",
		model: "zai/glm-5.3-flash",
		state: "running",
		memberStatus: "idle",
		activeSeconds: 42,
		activeUpdatedAt: Date.now(),
	});
	const strip = factory(tui, theme);
	try {
		const lines = strip.render(200).join("\n");
		assert.match(lines, /⧉myteam/, "team badge carries the short team name");
		assert.match(lines, /idle 42s/, "idle member shows banked time, not a ticking age");
	} finally {
		strip.dispose();
	}

	registry.updateExternalRun(memberId, { state: "done" });
	registry.resetRegistryForTesting();
	for (let i = 0; i < 7; i += 1) {
		registry.startDelegation(`ovf-${i}`, "builder", "zai/glm-5.3-flash", "sess", `run${i}`);
	}
	const crowded = factory(tui, theme);
	try {
		const lines = crowded.render(200).join("\n");
		assert.match(lines, /\+2 more/, "overflow row lists hidden runs");
		assert.match(lines, /5 running · \+2 more/, "header counts what is rendered");
	} finally {
		crowded.dispose();
	}
});

test("detail footer: [steer]/[stop] buttons render, stop needs y/n, hover bolds rows", () => {
	registry.resetRegistryForTesting();
	const theme = { fg: (_c, t) => t, bold: (t) => `*${t}*` };
	let stops = 0;
	registry.startDelegation("w5-run", "builder", "zai/glm-5.3", null, "scout");
	registry.attachControl("w5-run", {
		stop: () => {
			stops += 1;
		},
		steer: () => true,
	});
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen", theme);
	hooks.get("session_start")(undefined, driver.ctx);
	globalThis[registry.FLEET_OPENER]("w5-run");
	const component = driver.component();
	try {
		const buttonRow = () => {
			const lines = component.render(120);
			const y = lines.findIndex((l) => l.includes("[s] steer"));
			assert.ok(y >= 0, "footer action row with steer button rendered");
			assert.ok(lines[y]?.includes("[x] stop"), "stop button rendered beside steer");
			return y;
		};

		// Clicking steer opens the inline steer box.
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: 3, y: buttonRow() }),
			{ handled: true },
		);
		assert.ok(
			component.render(120).some((l) => l.includes("steer>")),
			"steer click opens the steer box",
		);
		component.handleInput(ESC);

		// Clicking stop arms the y/n guard; n cancels, y stops exactly once.
		component.handleMouse({ type: "click", button: "left", x: 16, y: buttonRow() });
		assert.ok(
			component.render(120).some((l) => l.includes("stop @scout? y/n")),
			"stop click arms the y/n prompt",
		);
		component.handleInput("n");
		assert.equal(stops, 0, "n must cancel without stopping");
		assert.ok(!component.render(120).some((l) => l.includes("y/n")), "prompt cleared after cancel");

		component.handleInput("x");
		assert.ok(
			component.render(120).some((l) => l.includes("stop @scout? y/n")),
			"x key arms the prompt too",
		);
		component.handleInput("y");
		assert.equal(stops, 1, "y confirms the stop");

		// Hover bolds the hovered list row on the next render.
		component.listSeen = true; // esc from detail backs out to the list
		component.handleInput(ESC);
		assert.deepEqual(
			component.handleMouse({ type: "move", button: "none", x: 5, y: 3 }),
			undefined,
		);
		assert.ok(
			component.render(120).some((l) => l.startsWith("*")),
			"hovered list row renders bold",
		);
	} finally {
		component.dispose();
	}
});
