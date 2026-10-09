import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// ACP consume: external ACP-speaking agents as delegatable children.
// TORUS_HOME must land before the registry import — it derives the logs dir at
// module load. The acp.json under that home points each fixture agent at a
// node script speaking recorded ACP v1 frames over stdio; the scenario is
// selected per agent via ACP_FIXTURE_MODE, and the fixture logs every frame
// it receives so tests can pin the exact wire contract.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-acp-consume-test-"));
process.env.TORUS_HOME = HOME;

const SCRATCH = mkdtempSync(path.join(tmpdir(), "torus-acp-fixture-"));
const FIXTURE = path.join(SCRATCH, "acp-fixture.mjs");

// ACP v1 fixture agent: reads newline-delimited JSON-RPC from stdin and
// replies per the scripted scenario selected by ACP_FIXTURE_MODE. The deny
// scenario defers its end_turn until the client's permission outcome arrives
// so the recorded response is guaranteed to be the one torus sent.
const FIXTURE_SOURCE = `
import { appendFileSync } from "node:fs";

const mode = process.env.ACP_FIXTURE_MODE ?? "happy";
const logFile = process.env.ACP_FIXTURE_LOG;
const PERMISSION_REQUEST_ID = 900;
let sessionId = null;
let promptId = null;
let buffer = "";

function log(entry) {
	if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\\n");
}

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\\n");
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function update(sessionUpdate, extra = {}) {
	send({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update: { sessionUpdate, ...extra } },
	});
}

function finishTurn() {
	update("agent_message_chunk", {
		messageId: "m2",
		content: { type: "text", text: "Second chunk." },
	});
	reply(promptId, { stopReason: "end_turn" });
}

function onPrompt(id) {
	promptId = id;
	if (mode === "die") {
		process.exit(3);
		return;
	}
	update("agent_message_chunk", {
		messageId: "m1",
		content: { type: "text", text: "First chunk. " },
	});
	update("plan", {
		entries: [{ content: "ignored", priority: "high", status: "pending" }],
	});
	update("agent_thought_chunk", {
		content: { type: "text", text: "thinking (ignored)" },
	});
	update("tool_call", {
		toolCallId: "call_001",
		title: "Reading fixture",
		kind: "read",
		status: "pending",
	});
	update("tool_call_update", { toolCallId: "call_001", status: "in_progress" });
	update("tool_call_update", { toolCallId: "call_001", status: "completed", content: [] });
	if (mode === "deny") {
		send({
			jsonrpc: "2.0",
			id: PERMISSION_REQUEST_ID,
			method: "session/request_permission",
			params: {
				sessionId,
				title: "Run dangerous tool?",
				options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
			},
		});
		return;
	}
	finishTurn();
}

function onLine(line) {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === PERMISSION_REQUEST_ID && message.result !== undefined) {
		log({ direction: "permission-response", message });
		finishTurn();
		return;
	}
	if (typeof message.method !== "string") return;
	log({ direction: "in", message });
	if (message.method === "initialize") {
		reply(message.id, {
			protocolVersion: 1,
			agentInfo: { name: "fixture-agent", version: "0.0.1" },
		});
		return;
	}
	if (message.method === "session/new") {
		sessionId = "sess-fixture-" + mode;
		reply(message.id, { sessionId });
		update("available_commands_update", { commands: [] });
		return;
	}
	if (message.method === "session/prompt") {
		onPrompt(message.id);
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		onLine(line);
		newline = buffer.indexOf("\\n");
	}
});
`;

writeFileSync(FIXTURE, FIXTURE_SOURCE, "utf8");

function fixtureAgent(mode) {
	return {
		command: process.execPath,
		args: [FIXTURE],
		env: {
			ACP_FIXTURE_MODE: mode,
			ACP_FIXTURE_LOG: path.join(SCRATCH, `${mode}-frames.jsonl`),
		},
	};
}

writeFileSync(
	path.join(HOME, "acp.json"),
	JSON.stringify(
		{
			agents: {
				"echo-acp": fixtureAgent("happy"),
				"deny-acp": fixtureAgent("deny"),
				"die-acp": fixtureAgent("die"),
			},
		},
		null,
		2,
	),
	"utf8",
);

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");
const acp = await import("../extensions/acp/index.ts");

after(() => {
	registry.setCustomSender(() => {});
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(SCRATCH, { recursive: true, force: true });
});

function readFrames(mode) {
	return readFileSync(path.join(SCRATCH, `${mode}-frames.jsonl`), "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

function delegationLog(outcome) {
	const record = registry.listDelegations().find((r) => r.id === outcome.delegationId);
	assert.ok(record, "registry record exists for the delegation");
	return readFileSync(record.logFile, "utf8");
}

test("happy path: chunks concatenate, tool activity logs, wire params exact", async () => {
	registry.resetRegistryForTesting();
	const outcome = await roster.runDelegation("echo-acp", "say the scripted things");

	assert.equal(outcome.ok, true, `outcome text: ${outcome.text}`);
	assert.equal(outcome.text, "First chunk. Second chunk.");
	assert.equal(outcome.details.model, "acp/echo-acp");
	assert.equal(outcome.details.turns, 1);
	assert.equal(outcome.details.usage.input, 0);
	assert.equal(outcome.details.usage.output, 0);
	assert.equal(outcome.details.usage.cost, 0);
	assert.equal(outcome.details.sessionId, "sess-fixture-happy");

	const record = registry.listDelegations().find((r) => r.id === outcome.delegationId);
	assert.equal(record.status, "done");
	assert.equal(record.sessionId, "sess-fixture-happy");

	const log = delegationLog(outcome);
	assert.match(log, /→ Reading fixture/);
	assert.match(log, /← result/);
	assert.doesNotMatch(log, /in_progress/);

	const frames = readFrames("happy");
	const initialize = frames.find((f) => f.message?.method === "initialize");
	assert.ok(initialize, "fixture received initialize");
	assert.deepEqual(initialize.message.params, {
		protocolVersion: 1,
		clientCapabilities: {},
		clientInfo: { name: "torus", version: initialize.message.params.clientInfo.version },
	});
	assert.match(initialize.message.params.clientInfo.version, /^\d+\.\d+\.\d+/);
	const sessionNew = frames.find((f) => f.message?.method === "session/new");
	assert.ok(sessionNew, "fixture received session/new");
	assert.deepEqual(sessionNew.message.params, { cwd: process.cwd(), mcpServers: [] });
	const prompt = frames.find((f) => f.message?.method === "session/prompt");
	assert.ok(prompt, "fixture received session/prompt");
	assert.deepEqual(prompt.message.params, {
		sessionId: "sess-fixture-happy",
		prompt: [{ type: "text", text: "say the scripted things" }],
	});
});

test("permission request: fail-closed cancelled outcome, denial visible, run still ok", async () => {
	registry.resetRegistryForTesting();
	const outcome = await roster.runDelegation("deny-acp", "try something dangerous");

	assert.equal(outcome.ok, true, `outcome text: ${outcome.text}`);
	assert.equal(outcome.text, "First chunk. Second chunk.");

	// The fixture logs the JSON-RPC response it received for its permission
	// request — the result must be the PermissionOutcome object itself.
	const frames = readFrames("deny");
	const answer = frames.find((f) => f.direction === "permission-response");
	assert.ok(answer, "fixture received a response to its permission request");
	assert.deepEqual(answer.message.result, { outcome: "cancelled" });

	const log = delegationLog(outcome);
	assert.match(log, /! permission request denied \(fail-closed\): Run dangerous tool\?/);
	assert.equal(
		registry.listDelegations().find((r) => r.id === outcome.delegationId).status,
		"done",
	);
});

test("child death mid-prompt: outcome not ok naming the agent and transport error", async () => {
	registry.resetRegistryForTesting();
	const outcome = await roster.runDelegation("die-acp", "die on me");

	assert.equal(outcome.ok, false);
	assert.match(outcome.text, /die-acp/);
	assert.match(outcome.text, /closed before responding \(exit 3\)/);
	assert.equal(outcome.details.exitCode, 1);
	assert.equal(
		registry.listDelegations().find((r) => r.id === outcome.delegationId).status,
		"failed",
	);
});

test("unknown agent: rejection names the configured ACP agent set", async () => {
	const outcome = await roster.runDelegation("ghost-acp", "boo");

	assert.equal(outcome.ok, false);
	assert.equal(outcome.details.error, "unknown-agent");
	assert.match(outcome.text, /Unknown agent "ghost-acp"/);
	assert.match(outcome.text, /acp agents \(external, own models\): deny-acp, die-acp, echo-acp/);
	assert.equal(outcome.delegationId, null);
});

test("skills are rejected pre-flight for ACP agents", async () => {
	const outcome = await roster.runDelegation(
		"echo-acp",
		"with skills",
		undefined,
		undefined,
		null,
		null,
		["some-skill"],
	);

	assert.equal(outcome.ok, false);
	assert.equal(outcome.details.error, "acp-skills-unsupported");
	assert.equal(outcome.delegationId, null);
});

test("acp.json validation: bad entries skip with a warning, siblings survive", async () => {
	const stderr = [];
	const prevWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk) => {
		stderr.push(String(chunk));
		return true;
	};
	try {
		writeFileSync(
			path.join(HOME, "acp.json"),
			JSON.stringify({
				agents: {
					"good-acp": { command: "/bin/true" },
					"no-command": { args: ["x"] },
					"bad-args": { command: "/bin/true", args: [1] },
					Bad_Name: { command: "/bin/true" },
				},
			}),
			"utf8",
		);
		const agents = acp.acpAgents();
		assert.deepEqual(Object.keys(agents), ["good-acp"]);
		assert.deepEqual(agents["good-acp"], { command: "/bin/true", args: [], env: {} });
		assert.equal(stderr.filter((l) => l.includes("no-command")).length, 1);
		assert.equal(stderr.filter((l) => l.includes("bad-args")).length, 1);
		assert.equal(stderr.filter((l) => l.includes("Bad_Name")).length, 1);

		writeFileSync(path.join(HOME, "acp.json"), "not json at all", "utf8");
		assert.deepEqual(acp.acpAgents(), {});
		assert.equal(stderr.filter((l) => l.includes("not valid JSON")).length, 1);

		rmSync(path.join(HOME, "acp.json"), { force: true });
		assert.deepEqual(acp.acpAgents(), {});
		assert.deepEqual(acp.acpAgentNames(), []);
	} finally {
		process.stderr.write = prevWrite;
	}
});
