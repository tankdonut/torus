import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Marker rendering only: the entity color a run carries in the fleet strip
// and browser must survive into its transcript markers (delegation start and
// result lines, team-wake episode lines), so a name reads as the same agent
// everywhere. TORUS_HOME lands before any extension import.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-notify-markers-test-"));
process.env.TORUS_HOME = HOME;

const { entityColor } = await import("../extensions/fleet/theme-kit.ts");
const registry = await import("../extensions/registry.ts");
const notify = await import("../extensions/notify/index.ts");

const renderers = new Map();
notify.registerNotify({
	registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
});

/** Colors render as <name>…</> tags so assertions can pin exact segments. */
const theme = { fg: (color, text) => `<${color}>${text}>`, bold: (text) => text };
const message = (details, content = "") => ({
	details,
	content: [{ type: "text", text: content }],
});
const render = (type, details, content = "") => {
	const component = renderers.get(type)(message(details, content), {}, theme);
	return component.render(400).join("\n");
};

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("delegation-start keeps the handle's fleet color", () => {
	const line = render(
		"torus.delegation-start",
		{ agent: "explorer", handle: "scout", delegationId: "d-1" },
		"map the registry",
	);
	const color = entityColor("scout");
	assert.match(line, new RegExp(`<${color}>@scout><customMessageText> delegated>`));
	assert.doesNotMatch(
		line,
		/<customMessageText>@scout>/,
		"handle must not render in message color",
	);
});

test("delegation-result keeps the handle's fleet color (agents fall back to their own)", () => {
	const handleLine = render("torus.delegation-result", {
		agent: "explorer",
		handle: "scout",
		ok: true,
		durationMs: 61000,
	});
	assert.match(
		handleLine,
		new RegExp(`<${entityColor("scout")}>@scout><customMessageText> finished>`),
	);
	assert.match(handleLine, /1m 01s · alt\+t for the transcript/);

	const agentLine = render("torus.delegation-result", { agent: "builder", ok: true });
	assert.match(
		agentLine,
		new RegExp(`<${entityColor("builder")}>builder><customMessageText> finished>`),
	);
});

test("team-wake episode lines keep the member's fleet color", () => {
	const line = render("torus.team-wake", {
		team: "build",
		members: [
			{ member: "scout", status: "idle", reason: "bootstrap ready" },
			{ member: "tank", status: "stopped", reason: "halted" },
		],
	});
	assert.match(
		line,
		new RegExp(
			`<customMessageText>team build: ><${entityColor("scout")}>@scout><customMessageText> idle>`,
		),
	);
	assert.match(
		line,
		new RegExp(
			`<customMessageText>team build: ><${entityColor("tank")}>@tank><customMessageText> stopped>`,
		),
	);
});

test("wake-batch lines route each click to its own run or member", () => {
	registry.resetRegistryForTesting();
	registry.publishExternalRun({
		id: "team-t1/scout",
		source: "torus-team:build-t1",
		label: "scout",
		handle: "scout",
		model: "zai/glm-5.3-flash",
		state: "running",
		memberStatus: "idle",
		activeSeconds: 10,
		activeUpdatedAt: Date.now(),
	});
	const component = renderers.get("torus.wake-batch")(
		message({
			entries: [
				{
					customType: "torus.team-wake",
					details: {
						team: "build",
						members: [{ member: "scout", status: "idle", reason: "bootstrap ready" }],
					},
				},
				{ customType: "torus.monitor-fired", details: { name: "ci", reason: "change" } },
				{
					customType: "torus.delegation-result",
					details: { agent: "explorer", handle: "scout", ok: true, delegationId: "d-9" },
				},
				{
					customType: "torus.delegation-result",
					details: { agent: "builder", ok: true, delegationId: "d-10" },
				},
				{
					customType: "torus.bg-exit",
					details: { name: "build", code: 0, durationMs: 61000, reason: "exited" },
				},
			],
		}),
		{},
		theme,
	);
	const rows = component.render(200);
	assert.equal(rows.length, 5, "one row per entry line");
	assert.match(rows[4], /bg build exited/);

	const opened = [];
	globalThis[registry.FLEET_OPENER] = (id) => opened.push(id ?? "list");
	try {
		assert.deepEqual(component.handleMouse({ type: "click", button: "left", x: 3, y: 0 }), {
			handled: true,
		});
		assert.deepEqual(component.handleMouse({ type: "click", button: "left", x: 3, y: 2 }), {
			handled: true,
		});
		assert.deepEqual(component.handleMouse({ type: "click", button: "left", x: 3, y: 3 }), {
			handled: true,
		});
		assert.equal(
			component.handleMouse({ type: "click", button: "left", x: 3, y: 1 }),
			undefined,
			"monitor line carries no target",
		);
		assert.equal(
			component.handleMouse({ type: "click", button: "left", x: 3, y: 4 }),
			undefined,
			"bg line carries no target",
		);
	} finally {
		delete globalThis[registry.FLEET_OPENER];
	}
	assert.deepEqual(opened, ["team-t1/scout", "d-9", "d-10"]);
});

test("bg-exit renders like a monitor line with exit, duration, and tail", () => {
	const clean = render("torus.bg-exit", {
		name: "build",
		code: 0,
		signal: null,
		durationMs: 61000,
		reason: "exited",
		stopped: false,
		timedOut: false,
		tail: "wrote 3 files",
	});
	assert.match(clean, /<success>✓> <customMessageText>bg build exited>/);
	assert.match(clean, /exit 0 · 1m 01s · wrote 3 files/);

	const failed = render("torus.bg-exit", {
		name: "build",
		code: 2,
		signal: null,
		durationMs: 500,
		reason: "exited",
		tail: "",
	});
	assert.match(failed, /<error>✗> <customMessageText>bg build exited>/);
	assert.match(failed, /exit 2 · 0s/);

	const stopped = render("torus.bg-exit", {
		name: "build",
		code: null,
		signal: "SIGTERM",
		durationMs: 2000,
		reason: "stopped",
		stopped: true,
	});
	assert.match(stopped, /<warning>■> <customMessageText>bg build stopped>/);
	assert.match(stopped, /signal SIGTERM · 2s/);
});

test("a team-wake member without a live run falls back to the list", () => {
	registry.resetRegistryForTesting();
	const component = renderers.get("torus.team-wake")(
		message({ team: "build", members: [{ member: "ghost", status: "idle", reason: "r" }] }),
		{},
		theme,
	);
	component.render(200);
	const opened = [];
	globalThis[registry.FLEET_OPENER] = (id) => opened.push(id ?? "list");
	try {
		component.handleMouse({ type: "click", button: "left", x: 3, y: 0 });
	} finally {
		delete globalThis[registry.FLEET_OPENER];
	}
	assert.deepEqual(opened, ["list"]);
});
