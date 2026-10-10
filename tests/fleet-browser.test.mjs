import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// FleetBrowser navigation + mouse-mode hygiene, driven through the real
// openFleet paths: FLEET_OPENER (strip click / alt+N focus open) and the
// alt+t shortcut (list open). TORUS_HOME must land before the registry
// import — it derives the logs dir at module load.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-fleet-browser-test-"));
process.env.TORUS_HOME = HOME;
// Hermetic sessions root for detail-transcript rendering; transcript.ts reads it at import.
const SESSIONS = mkdtempSync(path.join(tmpdir(), "torus-fleet-sessions-test-"));
process.env.PI_CODING_AGENT_SESSION_DIR = SESSIONS;

const registry = await import("../extensions/registry.ts");
const browser = await import("../extensions/browser/index.ts");
const team = await import("../extensions/team/index.ts");
const fleet = await import("../extensions/fleet/index.ts");

// Detail-transcript rendering drives engine ToolExecutionComponents, which
// need the shared theme initialized before their first render.
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

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
	rmSync(SESSIONS, { recursive: true, force: true });
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
	assert.equal(entry.message.details.handle, undefined, "combined marker carries no handle");
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
		activeSeconds: 5000,
		activeUpdatedAt: Date.now(),
	});
	const strip = factory(tui, theme);
	try {
		const lines = strip.render(200).join("\n");
		assert.match(lines, /⧉myteam/, "team badge carries the short team name");
		assert.match(lines, /· idle\b/, "idle member renders an idle marker");
		assert.doesNotMatch(lines, /idle \d/, "idle must not borrow the banked work clock");
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

test("strip: member and delegate lines show input→output tokens", () => {
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

	registry.startDelegation("del-tok", "builder", "zai/glm-5.3-flash", "sess", "scout");
	registry.updateDelegation("del-tok", {
		text: "working",
		turns: 3,
		usage: { input: 1234, output: 5678 },
	});
	registry.publishExternalRun({
		id: "ext-tok",
		label: "solo",
		handle: "solo",
		state: "running",
		turns: 2,
		tokensIn: 100,
		tokensOut: 250,
	});
	const strip = factory(tui, theme);
	try {
		const lines = strip.render(200).join("\n");
		assert.match(lines, /1\.2k→5\.7k/, "running delegate row shows input→output tokens");
		assert.match(lines, /100→250/, "external-run row shows input→output tokens");
		assert.doesNotMatch(lines, /}o\b/, "output-only token suffix is gone");
	} finally {
		strip.dispose();
	}
	registry.resetRegistryForTesting();
});

test("detail footer: [steer]/[stop] ride the status line, stop needs y/n, hover bolds rows", () => {
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
		const buttonLine = () => {
			const lines = component.render(160);
			const y = lines.findIndex((l) => l.includes("[s] steer"));
			assert.ok(y >= 0, "footer status line with steer button rendered");
			assert.ok(lines[y]?.includes("torus fleet"), "buttons ride the footer status line");
			assert.ok(lines[y]?.includes("[x] stop"), "stop button rendered beside steer");
			assert.ok(!lines[y]?.includes("s/[s]"), "grey steer/stop tips replaced by colored buttons");
			const buttons = component.footerButtons;
			assert.ok(buttons, "footer button hit-boxes registered");
			assert.equal(buttons.y, y, "hit-box y tracks the rendered footer line");
			return buttons;
		};

		// Hover bolds the steer button inside the footer line.
		const hoverBox = buttonLine();
		assert.deepEqual(
			component.handleMouse({ type: "move", button: "none", x: hoverBox.steer[0], y: hoverBox.y }),
			undefined,
		);
		assert.ok(
			component.render(160).some((l) => l.includes("*[s] steer*")),
			"hovered steer button renders bold",
		);

		// Clicking steer opens the inline steer box.
		const steerBox = buttonLine();
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: steerBox.steer[0], y: steerBox.y }),
			{ handled: true },
		);
		assert.ok(
			component.render(160).some((l) => l.includes("steer>")),
			"steer click opens the steer box",
		);
		component.handleInput(ESC);

		// Clicking stop arms the y/n guard; n cancels, y stops exactly once.
		const stopBox = buttonLine();
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: stopBox.stop[0], y: stopBox.y }),
			{ handled: true },
		);
		assert.ok(
			component.render(160).some((l) => l.includes("stop @scout? y/n")),
			"stop click arms the y/n prompt",
		);
		component.handleInput("n");
		assert.equal(stops, 0, "n must cancel without stopping");
		assert.ok(!component.render(160).some((l) => l.includes("y/n")), "prompt cleared after cancel");

		component.handleInput("x");
		assert.ok(
			component.render(160).some((l) => l.includes("stop @scout? y/n")),
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
			component.render(160).some((l) => l.startsWith("*")),
			"hovered list row renders bold",
		);
	} finally {
		component.dispose();
	}
});

test("detail footer: back label is colored, hoverable, and click-routed", () => {
	registry.resetRegistryForTesting();
	// Mark colors with real SGR codes so visibleWidth skips them — plain-text
	// markers would inflate the measured width and clip the line under test.
	const theme = {
		fg: (color, text) => `\x1b[38;5;${color === "accent" ? 99 : 240}m${text}\x1b[0m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
	registry.startDelegation("w7-run", "builder", "zai/glm-5.3", null, "backy");
	registry.attachControl("w7-run", { stop: () => {}, steer: () => true });
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen", theme);
	hooks.get("session_start")(undefined, driver.ctx);
	globalThis[registry.FLEET_OPENER]("w7-run"); // detail opened directly — no list behind it
	const component = driver.component();
	try {
		const backLine = () => {
			const lines = component.render(160);
			const y = lines.findIndex((l) => l.includes("[esc] back"));
			assert.ok(y >= 0, "footer status line carries the back chip");
			const buttons = component.footerButtons;
			assert.ok(buttons, "footer hit-boxes registered");
			assert.ok(buttons.back, "back chip has a click span");
			assert.equal(buttons.y, y, "back hit-box y tracks the rendered footer line");
			return buttons;
		};

		const box = backLine();
		assert.match(
			component.render(160)[box.y] ?? "",
			/\x1b\[38;5;99m\[esc\] back/,
			"back chip renders in the accent color, not dim",
		);

		// Hover bolds the back chip like the steer/stop buttons.
		assert.deepEqual(
			component.handleMouse({ type: "move", button: "none", x: box.back[0], y: box.y }),
			undefined,
		);
		assert.ok(
			component.render(160).some((l) => l.includes("\x1b[1m[esc] back")),
			"hovered back chip renders bold",
		);

		// Click backs out to the list when one was seen; a re-opened detail
		// re-enters steer mode, and clicking back there leaves it.
		component.listSeen = true;
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: box.back[0], y: box.y }),
			{ handled: true },
		);
		assert.ok(
			component.render(160).some((l) => l.includes("[esc] close")),
			"back click returns to the list view",
		);
		component.handleInput(ENTER);
		component.handleInput("s");
		assert.ok(
			component.render(160).some((l) => l.includes("steer>")),
			"steer box opened",
		);
		const steerBox = backLine();
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: steerBox.back[0], y: steerBox.y }),
			{ handled: true },
		);
		assert.ok(
			!component.render(160).some((l) => l.includes("steer>")),
			"back click leaves steer mode",
		);

		// Narrow width: the footer wraps its chips onto their own row; the back
		// chip stays whole and clickable (steer/stop drop before it does).
		const narrow = component.render(30);
		assert.ok(component.footerButtons?.back, "wrapped back chip keeps its click zone");
		assert.ok(!component.footerButtons?.steer, "steer drops when its row cannot fit the pair");
		assert.ok(
			(narrow[component.footerButtons.y] ?? "").includes("[esc] back"),
			"wrapped chip row carries the back chip",
		);

		// With no list behind the detail, back click closes the overlay.
		component.listSeen = false;
		const closeBox = backLine();
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: closeBox.back[0], y: closeBox.y }),
			{ handled: true },
		);
		assert.equal(driver.doneCount(), 1, "back click on a directly-opened detail closes it");
	} finally {
		component.dispose();
	}
});

test("narrow terminal: detail footer wraps its chips onto a second row, all clickable", () => {
	registry.resetRegistryForTesting();
	const theme = { fg: (_c, t) => t, bold: (t) => `*${t}*` };
	registry.startDelegation("w-narrow", "builder", "zai/glm-5.3", null, "narrow");
	registry.attachControl("w-narrow", { stop: () => {}, steer: () => true });
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen", theme);
	hooks.get("session_start")(undefined, driver.ctx);
	globalThis[registry.FLEET_OPENER]("w-narrow");
	const component = driver.component();
	try {
		const lines = component.render(40);
		const box = component.footerButtons;
		assert.ok(box, "footer hit-boxes registered");
		assert.ok(box.steer && box.stop && box.back, "all three chips keep spans at width 40");
		const chipRow = lines[box.y] ?? "";
		assert.ok(chipRow.startsWith("[s] steer"), "chips lead their own wrapped row");
		assert.ok(!chipRow.includes("torus fleet"), "info head lives on the row above");
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: box.back[0], y: box.y }),
			{ handled: true },
		);
		assert.equal(driver.doneCount(), 1, "back click closes the directly-opened detail");
	} finally {
		component.dispose();
	}
});

test("steer mode: the footer with its [esc] back chip stays on screen over a full transcript", () => {
	registry.resetRegistryForTesting();
	const sid = "0f0e0d0c-eeee-4bbb-8ccc-444455557777";
	mkdirSync(path.join(SESSIONS, "proj"), { recursive: true });
	const lines = [JSON.stringify({ type: "session", id: sid, timestamp: Date.now(), cwd: "/tmp" })];
	for (let i = 0; i < 30; i += 1) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `s${i}`,
				message: {
					role: "user",
					content: [{ type: "text", text: `msg ${i}\nsecond line\nthird line` }],
				},
			}),
		);
	}
	writeFileSync(
		path.join(SESSIONS, "proj", `2026-10-10T00-00-00-000Z_${sid}.jsonl`),
		`${lines.join("\n")}\n`,
		"utf8",
	);
	registry.startDelegation("w-steer-fit", "builder", "zai/glm-5.3", sid, "steery");
	registry.attachControl("w-steer-fit", { stop: () => {}, steer: () => true });
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen", { fg: (_c, t) => t, bold: (t) => `*${t}*` });
	hooks.get("session_start")(undefined, driver.ctx);
	globalThis[registry.FLEET_OPENER]("w-steer-fit");
	const component = driver.component();
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	try {
		component.render(160); // seeds items for the focused detail
		component.handleInput("s"); // steer box claims two extra footer rows
		const rendered = component.render(160);
		const box = component.footerButtons;
		assert.ok(box?.back, "back chip zone registered in steer mode");
		assert.ok(box.y < 24, `back chip row ${box.y} must sit inside the 24-row screen`);
		assert.ok(
			rendered.some((l) => l.includes("steer>")),
			"steer input visible",
		);
		assert.ok(
			(rendered[box.y] ?? "").includes("[esc] back"),
			"status header with the back chip renders on screen",
		);
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: box.back[0], y: box.y }),
			{ handled: true },
		);
		assert.ok(
			!component.render(160).some((l) => l.includes("steer>")),
			"back click leaves steer mode — the mouse-only exit",
		);
	} finally {
		if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
		else delete process.stdout.rows;
		component.dispose();
	}
});

test("list view: [esc] close chip closes the overlay by mouse", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("w-close", "builder", "zai/glm-5.3", null, "closey");
	const { shortcuts } = registerExtension();
	const driver = makeCtx("fullscreen", { fg: (_c, t) => t, bold: (t) => `*${t}*` });
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	try {
		const lines = component.render(100);
		const box = component.listButtons;
		assert.ok(box, "list close hit-box registered");
		assert.equal(box.y, 1, "close chip rides the pinned header row");
		assert.ok((lines[1] ?? "").includes("[esc] close"), "close chip rendered in the header");
		assert.deepEqual(
			component.handleMouse({ type: "click", button: "left", x: box.close[0], y: box.y }),
			{ handled: true },
		);
		assert.equal(driver.doneCount(), 1, "close click exits the fleet view");
	} finally {
		component.dispose();
	}
});

test("regular mode: raw SGR clicks open rows and the close chip without esc", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("w-raw", "builder", "zai/glm-5.3", null, "rawclick");
	const { shortcuts } = registerExtension();
	const driver = makeCtx("regular", { fg: (_c, t) => t, bold: (t) => `*${t}*` });
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	try {
		component.render(100);
		// First delegation row is overlay y=3 → SGR row 4; click routes through clickAt.
		component.handleInput("\x1b[<0;3;4M");
		assert.equal(component.mode, "detail", "raw click opens the row's detail");
		component.handleInput(ESC);
		assert.equal(component.mode, "list", "esc still backs out to the list");
		const box = component.listButtons;
		assert.ok(box, "close chip hit-box present");
		component.handleInput(`\x1b[<0;${box.close[0] + 1};2M`);
		assert.equal(driver.doneCount(), 1, "raw close-chip click exits the overlay");
	} finally {
		component.dispose();
	}
});

test("splitMouseBuffer: arrow keys pass through; dead mouse fragments still stripped", () => {
	const wheels = [];
	const clicks = [];
	const wheelCb = (d) => wheels.push(d);
	const clickCb = (x, y) => clicks.push([x, y]);
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[A", (d) => wheels.push(d)),
		{
			keys: "\x1b[A",
			held: "",
		},
	);
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[B", (d) => wheels.push(d)),
		{
			keys: "\x1b[B",
			held: "",
		},
	);
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[1;5A", (d) => wheels.push(d)),
		{
			keys: "\x1b[1;5A",
			held: "",
		},
	);
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[<64\x1b", (d) => wheels.push(d)),
		{ keys: "\x1b", held: "" },
		"dead mouse fragment before esc is stripped",
	);
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[<64;2;3", (d) => wheels.push(d)),
		{
			keys: "",
			held: "\x1b[<64;2;3",
		},
	);
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[<64;2;3M", (d) => wheels.push(d)),
		{
			keys: "",
			held: "",
		},
	);
	assert.deepEqual(wheels, [-1], "complete wheel sequence still routes to the wheel handler");
	assert.deepEqual(browser.splitMouseBuffer("\x1b[<0;5;4M", wheelCb, clickCb), {
		keys: "",
		held: "",
	});
	assert.deepEqual(clicks, [[5, 4]], "left press routes as a click with 1-based coords");
	assert.deepEqual(
		browser.splitMouseBuffer("\x1b[<0;5;4m", wheelCb, clickCb),
		{ keys: "", held: "" },
		"release events consume without clicking",
	);
	assert.deepEqual(clicks, [[5, 4]], "release must not fire the click handler");
});

test("list: windows past ten rows, arrow keys drive the cursor, clicks track the window", () => {
	registry.resetRegistryForTesting();
	for (let i = 0; i < 37; i += 1) {
		registry.startDelegation(`w-${i}`, "builder", "zai/glm-5.3", null, `w${i}`);
	}
	const { shortcuts } = registerExtension();
	const driver = makeCtx("regular", { fg: (_c, t) => t, bold: (t) => t });
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	try {
		let lines = component.render(200);
		const available = Math.max(3, (process.stdout.rows ?? 40) - 5);
		const rowRe = /@w\d+ \(/;
		assert.equal(
			lines.filter((l) => rowRe.test(l)).length,
			available - 2,
			"window fills with item rows (header and bar ride the window)",
		);
		assert.ok(
			lines.some((l) => l.includes("+4 more")),
			"overflow beyond the window is counted",
		);

		// Arrow keys (the raw CSI sequences the splitter used to eat) reach the
		// list and move the cursor to the very last item.
		for (let i = 0; i < 36; i += 1) component.handleInput("\x1b[B");
		lines = component.render(200);
		const lastHandle = component.items[36]?.record?.handle;
		assert.ok(lastHandle, "cursor landed on a real item");
		assert.ok(
			lines.some((l) => l.includes("❯") && l.includes(`@${lastHandle} (`)),
			"window follows the cursor to the last item",
		);
		assert.ok(
			lines.some((l) => l.includes("37/37") && l.includes(`↑${2 + 37 - available} above`)),
			"scroll hint reports position and rows above",
		);

		// Clicking a row that only exists thanks to windowing opens its detail.
		const y = lines.findIndex((l) => l.includes(`@${lastHandle} (`));
		assert.ok(y >= 1, "last row rendered inside the overlay");
		assert.ok(component.listRows.get(y) === 36, "click hit-box tracks the scrolled window");
		assert.deepEqual(component.handleMouse({ type: "click", button: "left", x: 3, y }), {
			handled: true,
		});
		assert.ok(
			component.render(200).some((l) => l.includes("[esc] back")),
			"click on the scrolled row opened its detail",
		);
	} finally {
		component.dispose();
	}
});

test("list and detail show the run duration once complete", () => {
	registry.resetRegistryForTesting();
	registry.startDelegation("dur-1", "builder", "zai/glm-5.3", null, "timing");
	registry.updateDelegation("dur-1", {
		text: "working",
		turns: 2,
		usage: { input: 100, output: 200 },
	});
	registry.finishDelegation("dur-1", true, "done", null, { toast: false });
	const { shortcuts } = registerExtension();
	const driver = makeCtx("regular", { fg: (_c, t) => t, bold: (t) => t });
	shortcuts.get("alt+t").handler(driver.ctx);
	const component = driver.component();
	try {
		const row = component.render(200).find((l) => l.includes("@timing ("));
		assert.ok(row, "finished delegation row rendered");
		assert.match(row, /2 turns · 100→200 tok · \d+s/, "list row shows the run duration");

		component.handleInput(ENTER);
		const footer = component.render(200).find((l) => l.includes("torus fleet"));
		assert.ok(footer, "detail footer rendered");
		assert.match(footer, /turn 2 · 100→200 tok · \d+s/, "detail footer shows the run duration");
	} finally {
		component.dispose();
	}
});

test("detail transcript: edit success renders its diff from persisted result details", () => {
	registry.resetRegistryForTesting();
	const sid = "0f0e0d0c-aaaa-4bbb-8ccc-444455559999";
	mkdirSync(path.join(SESSIONS, "proj"), { recursive: true });
	const lines = [
		JSON.stringify({ type: "session", id: sid, timestamp: Date.now(), cwd: "/tmp" }),
		JSON.stringify({
			type: "message",
			id: "m1",
			message: { role: "user", content: [{ type: "text", text: "fix the flag" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc9",
						name: "edit",
						arguments: {
							path: "src/a.ts",
							edits: [{ oldText: "const FLAG = 1;", newText: "const FLAG = 2;" }],
						},
					},
				],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "m3",
			message: {
				role: "toolResult",
				toolCallId: "tc9",
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
				details: {
					diff: "   1 function f() {\n-  2 \tconst FLAG = 1;\n+  2 \tconst FLAG = 2;\n   3 }",
					firstChangedLine: 2,
					patch: "@@ -1,3 +1,3 @@",
				},
			},
		}),
	];
	writeFileSync(
		path.join(SESSIONS, "proj", `2026-09-30T00-00-00-000Z_${sid}.jsonl`),
		`${lines.join("\n")}\n`,
		"utf8",
	);
	registry.startDelegation("fb-edit-1", "builder", "zai/glm-5.3", null, "edity");
	registry.finishDelegation("fb-edit-1", true, "done", sid, { toast: false });
	const { hooks } = registerExtension();
	const driver = makeCtx("fullscreen", { fg: (_color, text) => text, bold: (text) => text });
	hooks.get("session_start")(undefined, driver.ctx);
	globalThis[registry.FLEET_OPENER]("fb-edit-1");
	const component = driver.component();
	try {
		const rendered = component
			.render(100)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
		assert.ok(rendered.includes("edit src/a.ts"), "edit call header renders");
		assert.ok(
			rendered.includes("const FLAG = 2;"),
			"edit success diff must render from persisted details, not sit on a pending header",
		);
	} finally {
		component.dispose();
	}
});
