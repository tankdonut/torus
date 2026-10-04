import assert from "node:assert/strict";
import { test } from "node:test";

const { registerMcp, mcpStatusText, connectedServerCount } = await import(
	"../extensions/mcp/index.ts"
);
const { registerUi, mcpSettlePollActive } = await import("../extensions/ui/index.ts");

test("connectedServerCount counts only servers with declared tools (prefix-exact, underscore-safe)", () => {
	const active = [
		"read",
		"bash",
		"mcp__context7__query_docs",
		"mcp__grep_app__searchGitHub",
		"mcp__other__tool",
	];
	assert.equal(
		connectedServerCount(["context7", "grep_app"], active),
		2,
		"underscore server names match via exact mcp__<name>__ prefix",
	);
	assert.equal(
		connectedServerCount(["context7", "grep_app", "broken"], active),
		2,
		"server without tools does not count",
	);
	assert.equal(
		connectedServerCount(["app"], active),
		0,
		"prefix must not partially match grep_app",
	);
	assert.equal(connectedServerCount([], active), 0);
	assert.equal(
		connectedServerCount(["context7"], []),
		0,
		"no active tools means nothing connected",
	);
});

test("mcpStatusText: registered-but-down is visible, none-registered clears", () => {
	assert.equal(mcpStatusText(0, 0), undefined);
	assert.equal(mcpStatusText(2, 2), "MCP 2");
	assert.equal(mcpStatusText(1, 2), "MCP 1");
	assert.equal(mcpStatusText(0, 2), "MCP 0");
});

test("registerMcp registers servers; registerUi renders the count on the torus key", async () => {
	const registered = [];
	const handlers = {};
	let activeTools = [];
	const fakePi = {
		registerMcpServer: (name) => registered.push(name),
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getMcpServers: () => registered.map((name) => ({ name })),
		getActiveTools: () => activeTools,
	};
	registerMcp(fakePi);
	registerUi(fakePi);
	assert.deepEqual(registered, ["context7", "grep_app"]);
	assert.ok(handlers["session_start"], "session_start wiring missing");
	assert.ok(handlers["turn_start"], "turn_start wiring missing");

	const setStatusCalls = [];
	const ctx = {
		ui: {
			setStatus: (key, value) => setStatusCalls.push([key, value]),
			theme: {
				fg: (color, text) => `<${color}>${text}</${color}>`,
				bold: (text) => `*${text}*`,
			},
			model: undefined,
			thinkingLevel: undefined,
		},
	};
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(setStatusCalls[0][0], "torus", "MCP count must render on the torus key");
	assert.ok(
		setStatusCalls[0][1].includes("<warning>MCP 0</warning>"),
		"before connections settle: warning MCP 0",
	);
	assert.ok(mcpSettlePollActive(), "session_start must start the settle-poll");

	// connections settle in the background; the poll must repaint without waiting for turn_start
	activeTools = ["mcp__context7__query_docs", "mcp__grep_app__searchGitHub"];
	const { setTimeout } = await import("node:timers/promises");
	for (let i = 0; i < 20 && mcpSettlePollActive(); i++) await setTimeout(50);
	assert.ok(
		setStatusCalls.at(-1)[1].includes("<success>MCP 2</success>"),
		"settle-poll repaints once tools are declared, before any turn",
	);
	assert.ok(!mcpSettlePollActive(), "poll stops once every registered server is connected");
});

test("a new session_start restarts the settle-poll instead of stacking timers", () => {
	const handlers = {};
	let activeTools = [];
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getMcpServers: () => [{ name: "context7" }, { name: "grep_app" }],
		getActiveTools: () => activeTools,
	};
	registerUi(fakePi);
	const ctx = {
		ui: {
			setStatus: () => {},
			theme: {
				fg: (color, text) => `<${color}>${text}</${color}>`,
				bold: (text) => `*${text}*`,
			},
			model: undefined,
			thinkingLevel: undefined,
		},
	};
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.ok(mcpSettlePollActive(), "first session_start starts the poll");
	handlers["session_start"]({ type: "session_start", reason: "new" }, ctx);
	assert.ok(mcpSettlePollActive(), "second session_start keeps exactly one poll running");

	activeTools = ["mcp__context7__query_docs"];
	handlers["turn_start"]({ type: "turn_start" }, ctx);
	assert.ok(mcpSettlePollActive(), "turn_start does not disturb a running poll");
});
