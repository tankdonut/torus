import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Pins the pinned engine's MCP client against a stateless-agnostic stdio server
// (docs/smoke-checklist.md row 15, the manual smoke; this is its automated
// engine-side half). A real engine session — fake OpenAI-compatible model
// endpoint, isolated PI_CODING_AGENT_DIR + cwd, project .pi/mcp.json —
// connects the fixture through the engine's own stdio transport (newline-
// delimited JSON-RPC), and the model drives a full tools/call round-trip.
// A second registration of the same fixture in SILENT mode (reads requests,
// never replies, per-request timeout 2s) proves an unresponsive server fails
// the handshake cleanly without hanging the session or the other server.
const agentDir = mkdtempSync(path.join(tmpdir(), "torus-mcp-stateless-agent-"));
const cwd = mkdtempSync(path.join(tmpdir(), "torus-mcp-stateless-cwd-"));
const fixturePath = path.join(cwd, "stateless-mcp-fixture.mjs");
const liveLogPath = path.join(cwd, "fixture-live.log");
const deadLogPath = path.join(cwd, "fixture-dead.log");

// Stateless stdio MCP fixture: every response is computed from the received
// message alone — no session state, no per-connection memory, the default
// posture the 2026-07-28 revision makes standard (docs/extensions.md, MCP
// spec status). Framing matches the engine's StdioTransport exactly: one
// JSON-RPC message per newline on stdin/stdout.
const FIXTURE_SERVER = `
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = (entry) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + "\\n");
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const silent = process.env.SILENT === "1";
log({ method: "spawn", pid: process.pid });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const text = line.trim();
	if (!text) return;
	let msg;
	try {
		msg = JSON.parse(text);
	} catch {
		return;
	}
	const isRequest = typeof msg.id === "number" || typeof msg.id === "string";
	log({ method: msg.method, id: msg.id, params: msg.params });
	if (!isRequest || silent) return;
	if (msg.method === "initialize") {
		reply({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: msg.params?.protocolVersion ?? "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "stateless-fixture", version: "1.0.0" },
			},
		});
	} else if (msg.method === "tools/list") {
		reply({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				tools: [
					{
						name: "echo",
						description: "Echo the text argument back",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
		});
	} else if (msg.method === "tools/call") {
		reply({
			jsonrpc: "2.0",
			id: msg.id,
			result: { content: [{ type: "text", text: "echo:" + (msg.params?.arguments?.text ?? "") }] },
		});
	} else if (msg.method === "ping") {
		reply({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else {
		reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method: " + msg.method } });
	}
});
`;

// The fake model: first request of the session emits a tool call for the
// fixture's tool, every later request answers with plain text.
const TOOL_CALL_CHUNK = JSON.stringify({
	id: "c1",
	object: "chat.completion.chunk",
	created: 0,
	model: "fake-1",
	choices: [
		{
			index: 0,
			delta: {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call-echo-1",
						type: "function",
						function: { name: "mcp__fixture__echo", arguments: '{"text":"stateless-round-trip"}' },
					},
				],
			},
			finish_reason: null,
		},
	],
});
const TOOL_CALL_FINISH = JSON.stringify({
	id: "c1",
	object: "chat.completion.chunk",
	created: 0,
	model: "fake-1",
	choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
});
const PLAIN_CHUNK = JSON.stringify({
	id: "c1",
	object: "chat.completion.chunk",
	created: 0,
	model: "fake-1",
	choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
});
const PLAIN_FINISH = JSON.stringify({
	id: "c1",
	object: "chat.completion.chunk",
	created: 0,
	model: "fake-1",
	choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
});

const bodies = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		bodies.push(body);
		const first = bodies.length === 1;
		const chunks = first ? [TOOL_CALL_CHUNK, TOOL_CALL_FINISH] : [PLAIN_CHUNK, PLAIN_FINISH];
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of chunks) res.write(`data: ${chunk}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let session;
let bindStart = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = (logPath) =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	writeFileSync(fixturePath, FIXTURE_SERVER);
	writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mcppin: {
					baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					models: [{ id: "fake-1", name: "Fake 1", contextWindow: 32768, maxTokens: 1024 }],
				},
			},
		}),
	);
	// Project-level registration, exactly the smoke row's shape: the engine
	// reads .pi/mcp.json from the (trusted) session cwd and spawns command+args.
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		path.join(cwd, ".pi", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: {
					command: "node",
					args: [fixturePath],
					env: { FIXTURE_LOG: liveLogPath },
					exposure: "direct",
				},
				"fixture-dead": {
					command: "node",
					args: [fixturePath],
					env: { FIXTURE_LOG: deadLogPath, SILENT: "1" },
					exposure: "direct",
					timeout: 2,
				},
			},
		}),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const {
		createAgentSession,
		createMcpExtension,
		DefaultResourceLoader,
		SessionManager,
		ModelRuntime,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel("mcppin", "fake-1");
	assert.ok(model, "fake provider model not registered");
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [createMcpExtension()],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		model,
		modelRuntime,
		resourceLoader,
		// Explicit trusted project settings so the project .pi/mcp.json is read.
		settingsManager: SettingsManager.create(cwd, agentDir),
		sessionManager: SessionManager.inMemory(),
		cwd,
	});
	session = created.session;
	// Emits session_start, which connects the MCP servers in the background.
	bindStart = Date.now();
	await session.bindExtensions({});
});

after(() => {
	session?.dispose();
	// The engine closes stdio MCP transports on session_shutdown or process
	// exit, not on dispose(); without an explicit kill the connected fixture
	// child holds the test runner's event loop open. Same semantics as the
	// transport's own exit hook: SIGTERM the server's process group.
	for (const logPath of [liveLogPath, deadLogPath]) {
		let entries = [];
		try {
			entries = readLog(logPath);
		} catch {
			// fixture never spawned; nothing to kill
		}
		for (const entry of entries) {
			if (entry.method !== "spawn" || typeof entry.pid !== "number") continue;
			try {
				process.kill(-entry.pid, "SIGTERM");
			} catch {
				// process group already gone
			}
		}
	}
	server.closeIdleConnections?.();
	server.close();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

test("engine connects to the stateless stdio server via its own MCP client", async () => {
	const deadline = Date.now() + 10_000;
	while (!session.getActiveToolNames().includes("mcp__fixture__echo")) {
		assert.ok(Date.now() < deadline, "fixture tool never became active");
		await sleep(200);
	}
	const log = readLog(liveLogPath);
	const initialize = log.find((entry) => entry.method === "initialize");
	assert.ok(initialize, "fixture never received initialize");
	// The handshake came from the engine's client, not this harness.
	assert.equal(initialize.params?.clientInfo?.name, "pi");
	assert.equal(typeof initialize.params?.protocolVersion, "string");
	assert.ok(
		log.some((entry) => entry.method === "notifications/initialized"),
		"initialized notification missing",
	);
	assert.ok(
		log.some((entry) => entry.method === "tools/list"),
		"tools/list never arrived",
	);
	assert.ok(
		log.findIndex((e) => e.method === "initialize") <
			log.findIndex((e) => e.method === "tools/list"),
		"tools/list preceded initialize",
	);
});

test("model-driven tool round-trip through the engine's MCP client", async () => {
	const before = bodies.length;
	await session.prompt("echo stateless-round-trip through the MCP tool");
	assert.ok(bodies.length - before >= 2, "expected a tool-call turn and a result turn");
	// The fixture's tool was declared to the model and the tool result reached
	// the follow-up model request — the round-trip went through the engine.
	assert.ok(
		bodies[before].includes("mcp__fixture__echo"),
		"fixture tool not declared to the model",
	);
	assert.ok(
		bodies[bodies.length - 1].includes("echo:stateless-round-trip"),
		"tool result never reached the model context",
	);
	const call = readLog(liveLogPath).find((entry) => entry.method === "tools/call");
	assert.ok(call, "fixture never received tools/call");
	assert.equal(call.params?.name, "echo");
	assert.equal(call.params?.arguments?.text, "stateless-round-trip");
});

test("unresponsive server times out cleanly without hanging the session", async () => {
	// fixture-dead answers nothing; its 2s per-request timeout must fail the
	// handshake (initialize sent, tools/list never sent) well before this point
	// plus margin, while the live server keeps working.
	const giveUpAt = bindStart + 2 * 2000 + 1500;
	while (Date.now() < giveUpAt) await sleep(giveUpAt - Date.now());
	const deadLog = readLog(deadLogPath);
	assert.ok(
		deadLog.some((entry) => entry.method === "initialize"),
		"dead fixture never received initialize",
	);
	assert.ok(
		!deadLog.some((entry) => entry.method === "tools/list"),
		"dead fixture was discovered despite never answering initialize",
	);
	assert.ok(
		!session.getActiveToolNames().includes("mcp__fixture_dead__echo"),
		"dead fixture's tool must not be active",
	);
	assert.ok(
		session.getActiveToolNames().includes("mcp__fixture__echo"),
		"dead server broke the live one",
	);
	const started = Date.now();
	const before = bodies.length;
	await session.prompt("still alive?");
	assert.ok(Date.now() - started < 15_000, "prompt hung after an MCP connect failure");
	assert.ok(bodies.length - before >= 1, "prompt never reached the model");
	assert.equal(session.isStreaming, false);
});
