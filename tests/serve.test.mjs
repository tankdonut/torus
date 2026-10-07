import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// TORUS_HOME must land before the registry import — it derives the logs and
// runs dirs at module load. The fake engine writes one argv file per spawn
// (so "no spawn" is assertable) and emits the same message_end event the
// delegation-surface fixtures use; TORUS_ENGINE_BIN routes engine-child
// spawns at it. RPC attempts die on close (no protocol); the JSON fallback
// consumes the emitted event and the run succeeds.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-serve-test-"));
process.env.TORUS_HOME = HOME;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-serve-engines-"));
const ARGS_ENGINE = path.join(ENGINE_DIR, "args-engine.sh");
writeFileSync(
	ARGS_ENGINE,
	'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TORUS_ARGS_DIR/spawn-$$.txt"\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(ARGS_ENGINE, 0o755);
const ARGS_DIR = path.join(ENGINE_DIR, "argv");
mkdirSync(ARGS_DIR, { recursive: true });
process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;
process.env.TORUS_ARGS_DIR = ARGS_DIR;

const registry = await import("../extensions/registry.ts");
const serve = await import("../extensions/serve/index.ts");
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

function freshArgsDir() {
	rmSync(ARGS_DIR, { recursive: true, force: true });
	mkdirSync(ARGS_DIR, { recursive: true });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunDone(delegationId) {
	for (let i = 0; i < 500; i += 1) {
		const record = registry.listDelegations().find((r) => r.id === delegationId);
		if (record && record.status !== "running") return record;
		await sleep(20);
	}
	return null;
}

async function captureStdout(fn) {
	const chunks = [];
	const orig = process.stdout.write;
	process.stdout.write = (chunk) => {
		chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	};
	try {
		return { result: await fn(), output: chunks.join("") };
	} finally {
		process.stdout.write = orig;
	}
}

const openHandles = [];
let server = null;

after(async () => {
	for (const handle of openHandles) await handle.close();
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

function url(pathname) {
	assert.ok(server, "serve handle missing — first-start test must run first");
	return `http://127.0.0.1:${server.port}${pathname}`;
}

function authHeaders() {
	return { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
}

test("first start mints a 0600 auth file and prints the token exactly once", async () => {
	registry.resetRegistryForTesting();
	freshArgsDir();
	const { result, output } = await captureStdout(() => serve.startServe({ port: 0 }));
	openHandles.push(result);
	server = result;
	const printed = output.match(/serve token: [0-9a-f]{64}/g) ?? [];
	assert.equal(printed.length, 1, "token printed exactly once on first start");
	const authFile = path.join(HOME, "serve", "auth.json");
	assert.ok(existsSync(authFile), "auth.json created under TORUS_HOME");
	const auth = JSON.parse(readFileSync(authFile, "utf8"));
	assert.equal(auth.token, server.token, "printed token matches the file");
	assert.ok(typeof auth.createdAt === "string", "auth file records creation time");
	assert.equal(statSync(authFile).mode & 0o777, 0o600, "auth.json is owner-only");
});

test("GET /health is unauthenticated and reports ok + version", async () => {
	const res = await fetch(url("/health"));
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.ok, true);
	assert.equal(body.version, pkg.version);
	const unknown = await fetch(url("/nope"));
	assert.equal(unknown.status, 404);
	assert.equal((await unknown.json()).error, "not-found");
});

test("POST /run without or with a wrong bearer token is rejected 401", async () => {
	const payload = JSON.stringify({ agent: "builder", task: "auth probe" });
	const missing = await fetch(url("/run"), { method: "POST", body: payload });
	assert.equal(missing.status, 401, "missing Authorization header rejected");
	assert.equal((await missing.json()).error, "unauthorized");
	const bad = await fetch(url("/run"), {
		method: "POST",
		headers: { authorization: "Bearer deadbeef", "content-type": "application/json" },
		body: payload,
	});
	assert.equal(bad.status, 401, "wrong token rejected");
	assert.equal((await bad.json()).error, "unauthorized");
});

test("POST /run with an unknown agent returns the roster pre-flight error and spawns nothing", async () => {
	registry.resetRegistryForTesting();
	freshArgsDir();
	const res = await fetch(url("/run"), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ agent: "no-such-agent", task: "probe" }),
	});
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.equal(body.ok, false);
	assert.equal(body.error, "unknown-agent");
	assert.match(body.text, /Unknown agent "no-such-agent"/);
	assert.equal(readdirSync(ARGS_DIR).length, 0, "no engine spawn for a pre-flight refusal");
});

test("POST /run starts a fleet-visible delegation: registry record + run beacon", async () => {
	registry.resetRegistryForTesting();
	freshArgsDir();
	const res = await fetch(url("/run"), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ agent: "builder", task: "serve probe" }),
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(typeof body.delegationId, "string");
	const record = registry.listDelegations().find((r) => r.id === body.delegationId);
	assert.ok(record, "registry record exists for the response id");
	assert.equal(record.agent, "builder");
	assert.equal(record.parentSession, null, "serve delegations are session-free");
	assert.match(record.handle ?? "", /^srv-/, "run carries the serve correlation handle");
	const beacon = path.join(HOME, "runs", `${body.delegationId}.json`);
	assert.ok(existsSync(beacon), "run beacon written to the runs dir");
	assert.equal(JSON.parse(readFileSync(beacon, "utf8")).id, body.delegationId);
	await waitForRunDone(body.delegationId);
	assert.ok(readdirSync(ARGS_DIR).length >= 1, "the fake engine actually spawned");
});

test("POST /run with wait:true awaits the outcome and returns ok/text/usage/model", async () => {
	registry.resetRegistryForTesting();
	const res = await fetch(url("/run"), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ agent: "builder", task: "wait probe", wait: true }),
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.ok, true, `run outcome ok: ${body.text ?? ""}`);
	assert.equal(body.text, "done");
	assert.equal(body.usage?.input, 10);
	assert.equal(body.usage?.output, 20);
	assert.equal(body.model, "zai/glm-5.3");
	assert.equal(typeof body.delegationId, "string");
});

test("GET /runs requires auth and lists the serve-started runs", async () => {
	const unauth = await fetch(url("/runs"));
	assert.equal(unauth.status, 401);
	const res = await fetch(url("/runs"), { headers: authHeaders() });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.ok(Array.isArray(body.runs));
	const started = body.runs.find((r) => r.agent === "builder");
	assert.ok(started, "the serve-started run is listed");
	assert.ok(["done", "running"].includes(started.status));
	assert.equal(started.parentSession, null);
});

test("TORUS_SERVE=0 refuses to start", async () => {
	const prev = process.env.TORUS_SERVE;
	process.env.TORUS_SERVE = "0";
	try {
		await assert.rejects(() => serve.startServe({ port: 0 }), /TORUS_SERVE/);
	} finally {
		if (prev === undefined) delete process.env.TORUS_SERVE;
		else process.env.TORUS_SERVE = prev;
	}
});

test("EADDRINUSE produces a clean startup error naming the port and serve.json", async () => {
	const blocker = net.createServer();
	await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
	const takenPort = blocker.address().port;
	try {
		await assert.rejects(
			() => serve.startServe({ port: takenPort }),
			(err) => {
				assert.match(err.message, /already in use/);
				assert.match(err.message, new RegExp(`\\b${takenPort}\\b`));
				assert.match(err.message, /serve\.json/);
				return true;
			},
		);
	} finally {
		await new Promise((resolve) => blocker.close(resolve));
	}
});

test("subsequent starts read the token silently", async () => {
	const { result, output } = await captureStdout(() => serve.startServe({ port: 0 }));
	openHandles.push(result);
	assert.equal(output.includes("serve token:"), false, "token not reprinted");
	const auth = JSON.parse(readFileSync(path.join(HOME, "serve", "auth.json"), "utf8"));
	assert.equal(result.token, auth.token, "existing token reread from disk");
});
