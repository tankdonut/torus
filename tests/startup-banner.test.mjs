import assert from "node:assert/strict";
import { test } from "node:test";

const { VERSION, initTheme } = await import("@earendil-works/pi-coding-agent");
const { registerUi, bannerLines } = await import("../extensions/ui/index.ts");

// keyHint/keyText paint through the engine's theme singleton; the TUI
// initializes it before the first header paint, tests must do it themselves.
initTheme();

const painter = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `*${text}*`,
};

const baseOptions = {
	version: "9.9.9",
	engineVersion: "8.8.8",
	showDetails: true,
};

test("bannerLines collapsed: torus version line, compact hints, onboarding", () => {
	const lines = bannerLines(painter, { ...baseOptions, expanded: false });
	const text = lines.join("\n");
	assert.ok(
		text.includes("*torus*") && text.includes("9.9.9"),
		"collapsed banner must lead with the torus brand and version",
	);
	assert.ok(text.includes("(pi@8.8.8)"), "engine version must ride the version line");
	assert.ok(text.includes("interrupt"), "compact keybinding hints must be present");
	assert.ok(
		text.includes("commands") && text.includes("bash"),
		"slash-command and bash hints must be present",
	);
	assert.ok(
		text.includes("startup help and loaded resources."),
		"details suffix appears when the loaded-resources listing is visible",
	);
	assert.ok(
		text.includes("extend torus"),
		"onboarding must point at torus (and keep the pi-docs pointer)",
	);
});

test("bannerLines collapsed without details drops the loaded-resources suffix", () => {
	const text = bannerLines(painter, { ...baseOptions, expanded: false, showDetails: false }).join(
		"\n",
	);
	assert.ok(text.includes("startup help."), "hint line still present");
	assert.ok(!text.includes("loaded resources"), "details suffix must follow quietStartup header");
});

test("bannerLines expanded: torus-native rows plus the full keybinding sheet", () => {
	const lines = bannerLines(painter, { ...baseOptions, expanded: true });
	const text = lines.join("\n");
	for (const expected of [
		"torus serve",
		"torus acp-agent",
		"torus --help",
		"/roster",
		"/doctor",
		"alt+t",
		"to interrupt",
		"to cycle models",
		"drop files",
	]) {
		assert.ok(text.includes(expected), `expanded banner must mention ${expected}`);
	}
	assert.ok(!text.includes("loaded resources"), "expanded view has no details suffix");
});

function harness(overrides = {}) {
	const handlers = {};
	const setHeaderCalls = [];
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getMcpServers: () => [],
		getActiveTools: () => [],
		getSettings: () => ({ quietStartup: false, ...overrides.settings }),
		...overrides.pi,
	};
	registerUi(fakePi);
	const ctx = {
		mode: overrides.mode ?? "tui",
		ui: {
			setStatus: () => {},
			setHeader: (factory) => setHeaderCalls.push(factory),
			theme: painter,
		},
	};
	return { handlers, ctx, setHeaderCalls };
}

test("session_start installs the torus banner in tui mode", () => {
	const { handlers, ctx, setHeaderCalls } = harness();
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(setHeaderCalls.length, 1, "setHeader must be called exactly once");
	const factory = setHeaderCalls[0];
	const header = factory({}, painter);
	assert.ok(
		linesOf(header).includes(`(pi@${VERSION})`),
		"rendered banner carries the engine version",
	);
	header.setExpanded(true);
	assert.ok(
		linesOf(header).includes("torus serve"),
		"setExpanded(true) switches to the expanded torus rows",
	);
	header.setExpanded(false);
	assert.ok(
		!linesOf(header).includes("torus serve"),
		"setExpanded(false) returns to the compact banner",
	);
});

test("banner stays out of non-tui modes, quietStartup, and TORUS_BANNER=0", () => {
	const quiet = harness({ settings: { quietStartup: true } });
	quiet.handlers["session_start"]({ type: "session_start", reason: "startup" }, quiet.ctx);
	assert.equal(quiet.setHeaderCalls.length, 0, "quietStartup: true must keep the header silenced");

	const headless = harness({ mode: "json" });
	headless.handlers["session_start"]({ type: "session_start", reason: "startup" }, headless.ctx);
	assert.equal(headless.setHeaderCalls.length, 0, "non-tui modes never install the banner");

	process.env["TORUS_BANNER"] = "0";
	try {
		const suppressed = harness();
		suppressed.handlers["session_start"](
			{ type: "session_start", reason: "startup" },
			suppressed.ctx,
		);
		assert.equal(suppressed.setHeaderCalls.length, 0, "TORUS_BANNER=0 keeps pi's header");
	} finally {
		delete process.env["TORUS_BANNER"];
	}
});

function linesOf(header) {
	return header.render(120).join("\n");
}
