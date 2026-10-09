import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// ACP serve: `torus acp-agent` exposes torus as an ACP v1 agent over stdio.
// The fixture CLIENT here drives the REAL launcher (source mode resolves the
// repo payload without a built binary) with TORUS_ENGINE_BIN pointed at a
// fake RPC-mode engine, so the interception, the agent role, and the engine
// child spawn contract are all exercised end to end. The fake engine selects
// a scenario via TORUS_FAKE_ENGINE_MODE: happy (deltas + tool events +
// settle), die (exits non-zero mid-prompt), hang (one delta, never settles).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const LAUNCHER = path.join(root, "runtime", "bin", "torus.mjs");

const HOME = mkdtempSync(path.join(tmpdir(), "torus-acp-serve-test-"));
const SCRATCH = mkdtempSync(path.join(tmpdir(), "torus-acp-serve-fixture-"));

const ENGINE = path.join(SCRATCH, "fake-engine.mjs");
writeFileSync(
	ENGINE,
	[
		"#!/usr/bin/env node",
		"import { appendFileSync, writeFileSync } from 'node:fs';",
		"import path from 'node:path';",
		"",
		"const mode = process.env.TORUS_FAKE_ENGINE_MODE ?? 'happy';",
		"const pidDir = process.env.TORUS_FAKE_PID_DIR;",
		"const logFile = process.env.TORUS_FAKE_ENGINE_LOG;",
		"let buffer = '';",
		"",
		"// pid + argv on start: tests assert distinct children and the spawn contract.",
		"if (pidDir) {",
		"\twriteFileSync(",
		"\t\tpath.join(pidDir, 'pid-' + process.pid + '.txt'),",
		"\t\tString(process.pid) + '\\n' + JSON.stringify(process.argv),",
		"\t);",
		"}",
		"",
		"function log(line) {",
		"\tif (logFile) appendFileSync(logFile, line + '\\n');",
		"}",
		"function send(event) {",
		"\tprocess.stdout.write(JSON.stringify(event) + '\\n');",
		"}",
		"",
		"function onPrompt(command) {",
		"\tif (mode === 'die') {",
		"\t\tsend({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } });",
		"\t\tprocess.exit(3);",
		"\t\treturn;",
		"\t}",
		"\tif (mode === 'hang') {",
		"\t\tsend({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'stuck ' } });",
		"\t\treturn;",
		"\t}",
		"\t// The real engine acks the prompt command at preflight, before the run;",
		"\t// mirror that order so the settle race is exercised for real.",
		"\tsend({ type: 'response', id: command.id, command: 'prompt', success: true });",
		"\tsend({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } });",
		"\tsend({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'from ' } });",
		"\tsend({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'fake engine' } });",
		"\tsend({ type: 'tool_execution_start', toolCallId: 'call_001', toolName: 'read', args: { path: 'x' } });",
		"\tsend({ type: 'tool_execution_end', toolCallId: 'call_001', isError: false });",
		"\tsend({",
		"\t\ttype: 'message_end',",
		"\t\tmessage: {",
		"\t\t\trole: 'assistant',",
		"\t\t\tcontent: [{ type: 'text', text: 'Hello from fake engine' }],",
		"\t\t\tusage: { input: 1, output: 2 },",
		"\t\t},",
		"\t});",
		"\tsend({ type: 'agent_settled' });",
		"}",
		"",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => {",
		"\tbuffer += chunk;",
		"\tlet newline = buffer.indexOf('\\n');",
		"\twhile (newline !== -1) {",
		"\t\tconst line = buffer.slice(0, newline);",
		"\t\tbuffer = buffer.slice(newline + 1);",
		"\t\tif (line.trim()) {",
		"\t\t\tlog(line);",
		"\t\t\tconst command = JSON.parse(line);",
		"\t\t\tif (command.type === 'prompt') onPrompt(command);",
		"\t}",
		"\t\tnewline = buffer.indexOf('\\n');",
		"\t}",
		"});",
		"process.stdin.on('end', () => process.exit(0));",
	].join("\n"),
	"utf8",
);
chmodSync(ENGINE, 0o755);

const agents = [];

function agentEnv(pidDir, mode) {
	const env = { ...process.env };
	for (const key of ["TORUS_ROOT", "TORUS_ENGINE", "TORUS_ENGINE_BIN", "TORUS_PI_BIN"]) {
		delete env[key];
	}
	env.TORUS_HOME = HOME;
	env.TORUS_ENGINE_BIN = ENGINE;
	env.TORUS_FAKE_PID_DIR = pidDir;
	env.TORUS_FAKE_ENGINE_MODE = mode ?? "happy";
	env.TORUS_FAKE_ENGINE_LOG = path.join(SCRATCH, `engine-${agents.length}.jsonl`);
	return env;
}

class AcpAgent {
	constructor(mode) {
		this.pidDir = mkdtempSync(path.join(SCRATCH, "pids-"));
		this.proc = spawn(process.execPath, [LAUNCHER, "acp-agent"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: agentEnv(this.pidDir, mode),
			detached: true,
		});
		agents.push(this);
		this.nextId = 1;
		this.messages = [];
		this.waiters = new Set();
		this.exited = new Promise((resolve) => {
			this.proc.on("exit", (code, signal) => resolve({ code, signal }));
		});
		this.proc.on("error", () => {});
		this.buffer = "";
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf("\n");
			while (newline !== -1) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.onLine(line);
				newline = this.buffer.indexOf("\n");
			}
		});
	}

	onLine(line) {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		this.messages.push(message);
		for (const waiter of [...this.waiters]) waiter.check(message);
	}

	/** Resolve with the first unconsumed matching message; each match is consumed once. */
	async awaitMessage(predicate, label, timeoutMs = 10000) {
		const match = (m) => !m.consumed && predicate(m);
		const found = this.messages.find(match);
		if (found) {
			found.consumed = true;
			return found;
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				check: (m) => {
					if (!match(m)) return;
					this.waiters.delete(waiter);
					clearTimeout(timer);
					m.consumed = true;
					resolve(m);
				},
			};
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`timed out awaiting ${label} (${this.messages.length} messages so far)`));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	send(object) {
		this.proc.stdin.write(`${JSON.stringify(object)}\n`);
	}

	request(method, params) {
		const id = this.nextId++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return this.awaitMessage(
			(m) => m.id === id && (m.result !== undefined || m.error !== undefined),
			`response to ${method}`,
		);
	}

	notify(method, params) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	update(kind, sessionId) {
		return this.awaitMessage(
			(m) =>
				m.method === "session/update" &&
				m.params?.sessionId === sessionId &&
				m.params.update?.sessionUpdate === kind,
			`${kind} update`,
		).then((m) => m.params.update);
	}

	childPids() {
		return readdirSync(this.pidDir).map((file) =>
			Number(readFileSync(path.join(this.pidDir, file), "utf8").split("\n")[0]),
		);
	}

	childArgv() {
		return readdirSync(this.pidDir).map((file) =>
			JSON.parse(
				readFileSync(path.join(this.pidDir, file), "utf8").split("\n").slice(1).join("\n"),
			),
		);
	}

	async end() {
		this.proc.stdin.end();
		return this.exited;
	}
}

async function waitFor(claim, label, timeoutMs = 5000) {
	const start = Date.now();
	for (;;) {
		if (claim()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

after(async () => {
	for (const agent of agents) {
		if (agent.proc.exitCode !== null || agent.proc.signalCode !== null) continue;
		try {
			process.kill(-agent.proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	for (const agent of agents) {
		try {
			process.kill(-agent.proc.pid, "SIGKILL");
		} catch {}
	}
	rmSync(HOME, { recursive: true, force: true });
	rmSync(SCRATCH, { recursive: true, force: true });
});

test("happy round-trip: initialize, session/new, streamed chunks, tool updates, end_turn", async () => {
	const agent = new AcpAgent("happy");

	const init = await agent.request("initialize", {
		protocolVersion: 1,
		clientCapabilities: {},
		clientInfo: { name: "fixture-client", version: "0.0.1" },
	});
	assert.equal(init.error, undefined, `initialize errored: ${JSON.stringify(init.error)}`);
	assert.equal(init.result.protocolVersion, 1);
	assert.equal(init.result.agentCapabilities.loadSession, false);
	assert.equal(init.result.agentCapabilities.promptCapabilities.embeddedContext, false);
	assert.equal(init.result.agentInfo.name, "torus");
	assert.equal(init.result.agentInfo.title, "torus");
	assert.equal(init.result.agentInfo.version, repoPkg.version);
	assert.deepEqual(init.result.authMethods, []);

	const session = await agent.request("session/new", { cwd: SCRATCH, mcpServers: [] });
	assert.equal(session.error, undefined);
	const sessionId = session.result.sessionId;
	assert.equal(typeof sessionId, "string");
	assert.ok(sessionId.length > 0, "sessionId must be non-empty");

	const prompt = await agent.request("session/prompt", {
		sessionId,
		prompt: [
			{ type: "text", text: "say " },
			{ type: "text", text: "it" },
		],
	});

	const chunks = [];
	for (let i = 0; i < 3; i++) {
		chunks.push(await agent.update("agent_message_chunk", sessionId));
	}
	assert.equal(
		chunks.map((u) => u.content.text).join(""),
		"Hello from fake engine",
		"text deltas must concatenate to the fake engine's stream",
	);
	assert.equal(new Set(chunks.map((u) => u.messageId)).size, 1, "one messageId per prompt turn");
	assert.equal(chunks[0].content.type, "text");

	const toolCall = await agent.update("tool_call", sessionId);
	assert.equal(toolCall.toolCallId, "call_001");
	assert.equal(toolCall.title, "read");
	assert.equal(toolCall.kind, "other");
	assert.equal(toolCall.status, "pending");
	const inProgress = await agent.update("tool_call_update", sessionId);
	assert.deepEqual(
		{ toolCallId: inProgress.toolCallId, status: inProgress.status },
		{ toolCallId: "call_001", status: "in_progress" },
	);
	const completed = await agent.update("tool_call_update", sessionId);
	assert.deepEqual(
		{ toolCallId: completed.toolCallId, status: completed.status },
		{ toolCallId: "call_001", status: "completed" },
	);

	assert.deepEqual(prompt.result, { stopReason: "end_turn" });

	// The prompt's text blocks reach the engine concatenated into one task.
	const engineLines = readFileSync(path.join(SCRATCH, "engine-0.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
	const enginePrompt = engineLines.find((c) => c.type === "prompt");
	assert.ok(enginePrompt, "engine child received the prompt command");
	assert.equal(enginePrompt.message, "say it");

	await waitFor(() => agent.childPids().length === 1, "engine child pid file");
	const argv = agent.childArgv()[0];
	const modeIndex = argv.indexOf("--mode");
	assert.notEqual(modeIndex, -1, "engine child spawns in rpc mode");
	assert.equal(argv[modeIndex + 1], "rpc");
	assert.ok(
		argv.includes(path.join(root, "extensions", "hashline", "index.ts")),
		"child extension set rides along",
	);

	const exit = await agent.end();
	assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
});

test("two session/new in a row: distinct sessionIds, independent engine children", async () => {
	const agent = new AcpAgent("happy");
	await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

	const first = await agent.request("session/new", { cwd: SCRATCH });
	const second = await agent.request("session/new", { cwd: SCRATCH });
	assert.notEqual(first.result.sessionId, second.result.sessionId);

	await waitFor(() => agent.childPids().length === 2, "two engine child pid files");
	const pids = agent.childPids();
	assert.equal(pids.length, 2);
	assert.notEqual(pids[0], pids[1], "each session spawns its own engine child");

	const exit = await agent.end();
	assert.equal(exit.code, 0);
});

test("engine child death mid-prompt: prompt request gets a JSON-RPC error, no hang", async () => {
	const agent = new AcpAgent("die");
	await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
	const session = await agent.request("session/new", { cwd: SCRATCH });

	const failed = await agent.request("session/prompt", {
		sessionId: session.result.sessionId,
		prompt: [{ type: "text", text: "die on me" }],
	});
	assert.ok(failed.error, "a dead engine child must surface a JSON-RPC error, not a hang");
	assert.equal(failed.error.code, -32603);
	assert.match(failed.error.message, /closed before responding|exited \(code 3\)/);

	const exit = await agent.end();
	assert.equal(exit.code, 0);
});

test("session/load and unimplemented methods answer method-not-found", async () => {
	const agent = new AcpAgent("happy");
	await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

	const load = await agent.request("session/load", {
		sessionId: "whatever",
		cwd: SCRATCH,
		mcpServers: [],
	});
	assert.ok(load.error, "session/load must be refused");
	assert.equal(load.error.code, -32601);
	assert.match(load.error.message, /session\/load/);

	const fsRead = await agent.request("fs/read_text_file", { path: "/etc/hostname" });
	assert.ok(fsRead.error, "fs/* must be refused");
	assert.equal(fsRead.error.code, -32601);

	const terminal = await agent.request("terminal/start", { cwd: SCRATCH });
	assert.ok(terminal.error, "terminal/* must be refused");
	assert.equal(terminal.error.code, -32601);

	const exit = await agent.end();
	assert.equal(exit.code, 0);
});

test("session/* before initialize is refused, initialize afterwards still works", async () => {
	const agent = new AcpAgent("happy");

	const early = await agent.request("session/new", { cwd: SCRATCH });
	assert.ok(early.error, "session/new before initialize must error");
	assert.equal(early.error.code, -32002);

	const init = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
	assert.equal(init.error, undefined);

	const exit = await agent.end();
	assert.equal(exit.code, 0);
});

test("session/cancel: prompt settles cancelled and the engine child is killed", async () => {
	const agent = new AcpAgent("hang");
	await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
	const session = await agent.request("session/new", { cwd: SCRATCH });
	const sessionId = session.result.sessionId;

	const pendingPrompt = agent.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "run forever" }],
	});
	const stuck = await agent.update("agent_message_chunk", sessionId);
	assert.equal(stuck.content.text, "stuck ");

	await waitFor(() => agent.childPids().length === 1, "engine child pid file");
	const childPid = agent.childPids()[0];
	assert.ok(pidAlive(childPid), "engine child is running before cancel");

	agent.notify("session/cancel", { sessionId });
	const settled = await pendingPrompt;
	assert.deepEqual(settled.result, { stopReason: "cancelled" });

	await waitFor(() => !pidAlive(childPid), "engine child to die after cancel");
	const exit = await agent.end();
	assert.equal(exit.code, 0);
});
