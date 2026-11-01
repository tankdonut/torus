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
const notify = await import("../extensions/notify/index.ts");

const renderers = new Map();
notify.registerNotify({
	registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
});

/** Colors render as <name>…</> tags so assertions can pin exact segments. */
const theme = { fg: (color, text) => `<${color}>${text}>`, bold: (text) => text };
const render = (type, details, content = "") => {
	const component = renderers.get(type)(
		{ details, content: [{ type: "text", text: content }] },
		{},
		theme,
	);
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
