import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Pins the wake-up contract torus relies on against the pinned pi engine:
// a followUp user message on an idle session must start a turn, a triggerTurn
// custom marker must start a turn AND reach the model context, and a followUp
// queued mid-stream must drain once the run settles. A fake OpenAI-compatible
// endpoint serves the model; an isolated PI_CODING_AGENT_DIR + cwd keep the
// harness hermetic (no credentials, no project extensions, in-memory session).
const agentDir = mkdtempSync(path.join(tmpdir(), "torus-pi-wake-contract-"));
const cwd = mkdtempSync(path.join(tmpdir(), "torus-pi-wake-cwd-"));

const bodies = [];
let delayMs = 0;
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		bodies.push(body);
		const chunks = [
			JSON.stringify({
				id: "c1",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake-1",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
			}),
			JSON.stringify({
				id: "c1",
				object: "chat.completion.chunk",
				created: 0,
				model: "fake-1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
		];
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const chunk of chunks) res.write(`data: ${chunk}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		}, delayMs);
	});
});

let session;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				wakepin: {
					baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
					api: "openai-completions",
					apiKey: "dummy",
					models: [{ id: "fake-1", name: "Fake 1", contextWindow: 32768, maxTokens: 1024 }],
				},
			},
		}),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { createAgentSession, SessionManager, ModelRuntime } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const modelRuntime = await ModelRuntime.create();
	const model = modelRuntime.getModel("wakepin", "fake-1");
	assert.ok(model, "fake provider model not registered");
	const created = await createAgentSession({
		model,
		modelRuntime,
		sessionManager: SessionManager.inMemory(),
		noTools: true,
		cwd,
	});
	session = created.session;
});

after(() => {
	session?.dispose();
	server.close();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

test("idle session: a followUp user message starts a turn", async () => {
	await session.prompt("turn one");
	await sleep(300);
	assert.equal(session.isStreaming, false);
	const before = bodies.length;
	void session.sendUserMessage("[torus] wake", { deliverAs: "followUp" });
	await sleep(1500);
	assert.ok(bodies.length > before, "expected a new model request for the queued follow-up");
});

test("idle session: a triggerTurn custom marker starts a turn and reaches the model", async () => {
	const before = bodies.length;
	session.sendCustomMessage(
		{
			customType: "torus.team-wake",
			content: [{ type: "text", text: "WAKE-MARKER-PAYLOAD: @two is idle" }],
			display: true,
			details: { member: "two" },
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	await sleep(1500);
	assert.ok(bodies.length > before, "expected a new model request for the wake marker");
	assert.ok(
		bodies.slice(before).some((body) => body.includes("WAKE-MARKER-PAYLOAD")),
		"wake marker text must reach the model context",
	);
});

test("streaming session: a queued followUp drains once the run settles", async () => {
	delayMs = 800;
	const before = bodies.length;
	const run = session.prompt("slow turn");
	await sleep(300);
	assert.equal(session.isStreaming, true);
	void session.sendUserMessage("[torus] queued while streaming", { deliverAs: "followUp" });
	await run;
	await sleep(1500);
	assert.ok(
		bodies.length - before >= 2,
		`queued follow-up must drain into its own turn (delta ${bodies.length - before})`,
	);
	delayMs = 0;
});
