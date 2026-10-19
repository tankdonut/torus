import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { startSignRelay } = await import("../extensions/sandbox/sign-relay.ts");

const sshKeygenProbe = spawnSync("ssh-keygen", ["-Y"], { encoding: "utf8" });
const sshKeygenAvailable = sshKeygenProbe.error === undefined;
const skipReason = sshKeygenAvailable ? false : "ssh-keygen is not installed";

function makeKeyring() {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-signrelay-key-"));
	const privateKey = path.join(dir, "key");
	const generated = spawnSync(
		"ssh-keygen",
		["-t", "ed25519", "-N", "", "-C", "torus-sign-relay-test", "-f", privateKey],
		{ encoding: "utf8" },
	);
	assert.equal(generated.status, 0, `ssh-keygen keygen failed: ${generated.stderr}`);
	return {
		dir,
		privateKey,
		principal: "torus-sign-relay-test",
		publicLine: readFileSync(`${privateKey}.pub`, "utf8").trim(),
	};
}

function makeScratch() {
	return mkdtempSync(path.join(tmpdir(), "torus-signrelay-scratch-"));
}

// Async spawn: the relay watcher shares this process, so a spawnSync here
// would block the event loop and starve the very poller the wrapper awaits
// (in production the watcher and the wrapper are separate processes).
function runWrapper(relay, privateKey, payload) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[relay.wrapperScriptPath, "-Y", "sign", "-n", "git", "-f", privateKey, payload],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ status: code, stdout, stderr }));
	});
}

function cleanup(...dirs) {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}
}

function verifySignature(payloadPath, keyring) {
	const allowedSigners = path.join(keyring.dir, "allowed_signers");
	writeFileSync(allowedSigners, `${keyring.principal} ${keyring.publicLine}\n`);
	const verified = spawnSync(
		"ssh-keygen",
		[
			"-Y",
			"verify",
			"-f",
			allowedSigners,
			"-I",
			keyring.principal,
			"-n",
			"git",
			"-s",
			`${payloadPath}.sig`,
		],
		{ input: readFileSync(payloadPath), encoding: "utf8" },
	);
	assert.equal(
		verified.status,
		0,
		`verify failed for ${payloadPath}:\n${verified.stderr}${verified.stdout}`,
	);
}

async function waitForFile(filePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(filePath) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(existsSync(filePath), `timed out waiting for ${filePath}`);
}

function listFilesRecursive(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFilesRecursive(full));
		else files.push(full);
	}
	return files;
}

test("end-to-end: wrapper relays a sign request and the signature verifies", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	try {
		assert.ok(existsSync(relay.wrapperScriptPath), "wrapper script written");
		const payload = path.join(keyring.dir, "payload.txt");
		writeFileSync(payload, "torus sign relay end-to-end\n");
		const signed = await runWrapper(relay, keyring.privateKey, payload);
		assert.equal(signed.status, 0, `wrapper exited nonzero:\n${signed.stderr}`);
		const signaturePath = `${payload}.sig`;
		assert.ok(existsSync(signaturePath), "signature file written next to the payload");
		const allowedSigners = path.join(keyring.dir, "allowed_signers");
		writeFileSync(allowedSigners, `${keyring.principal} ${keyring.publicLine}\n`);
		const verified = spawnSync(
			"ssh-keygen",
			[
				"-Y",
				"verify",
				"-f",
				allowedSigners,
				"-I",
				keyring.principal,
				"-n",
				"git",
				"-s",
				signaturePath,
			],
			{ input: readFileSync(payload), encoding: "utf8" },
		);
		assert.equal(verified.status, 0, `verify failed:\n${verified.stderr}${verified.stdout}`);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("missing key: wrapper exits nonzero with a relay-branded stderr line", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	try {
		const payload = path.join(keyring.dir, "payload.txt");
		writeFileSync(payload, "content that will not be signed\n");
		const missingKey = path.join(keyring.dir, "absent-key");
		const signed = await runWrapper(relay, missingKey, payload);
		assert.notEqual(signed.status, 0, "wrapper must fail when the key is missing");
		assert.match(signed.stderr, /torus sign relay/);
		assert.match(signed.stderr, /ssh-keygen failed/);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("after stop(): wrapper invocations fail fast nonzero", { skip: skipReason }, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	await relay.stop();
	try {
		const payload = path.join(keyring.dir, "payload.txt");
		writeFileSync(payload, "post-stop content\n");
		const startedAt = Date.now();
		const signed = await runWrapper(relay, keyring.privateKey, payload);
		const elapsed = Date.now() - startedAt;
		assert.notEqual(signed.status, 0, "wrapper must fail after the relay stopped");
		assert.match(signed.stderr, /torus sign relay/);
		assert.ok(elapsed < 5000, `expected fail-fast, took ${elapsed}ms`);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("malformed request: error response is written and the watcher keeps serving", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	try {
		writeFileSync(path.join(relay.requestsDir, "broken.req.json"), "{ this is not json");
		const responsePath = path.join(scratch, "responses", "broken.resp.json");
		const deadline = Date.now() + 5000;
		while (!existsSync(responsePath) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const response = JSON.parse(readFileSync(responsePath, "utf8"));
		assert.equal(response.ok, false);
		assert.match(response.error, /malformed request/);
		const payload = path.join(keyring.dir, "payload.txt");
		writeFileSync(payload, "watcher still alive\n");
		const signed = await runWrapper(relay, keyring.privateKey, payload);
		assert.equal(signed.status, 0, `sign after malformed request failed:\n${signed.stderr}`);
		// Processed requests are unlinked once handled; the wrapper unlinks
		// the response it consumed. Nothing named *.req.json lingers.
		assert.deepEqual(
			readdirSync(relay.requestsDir).filter((name) => name.endsWith(".req.json")),
			[],
		);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("lifecycle: stop and start are idempotent; a restarted relay serves again", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	try {
		await relay.stop();
		await relay.stop();
		await relay.start();
		await relay.start();
		const payload = path.join(keyring.dir, "payload.txt");
		writeFileSync(payload, "restart\n");
		const signed = await runWrapper(relay, keyring.privateKey, payload);
		assert.equal(signed.status, 0, `sign after restart failed:\n${signed.stderr}`);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("deadline: wrapper exits nonzero with a timeout on stderr when no watcher answers", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20, requestTimeoutMs: 150 });
	await relay.stop();
	// Remove the fail-fast marker so the wrapper exercises its wait deadline
	// rather than the stopped check — the honest no-watcher situation.
	rmSync(path.join(scratch, "stopped"), { force: true });
	try {
		const payload = path.join(keyring.dir, "payload.txt");
		writeFileSync(payload, "nobody is listening\n");
		const startedAt = Date.now();
		const signed = await runWrapper(relay, keyring.privateKey, payload);
		const elapsed = Date.now() - startedAt;
		assert.notEqual(signed.status, 0, "wrapper must fail when no response ever arrives");
		assert.match(signed.stderr, /torus sign relay/);
		assert.match(signed.stderr, /timed out after 150ms waiting for the host signer/);
		assert.ok(elapsed >= 150, `wrapper gave up before its deadline (${elapsed}ms)`);
		assert.ok(elapsed < 5000, `wrapper burned far past its deadline (${elapsed}ms)`);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("kill timeout: a hung ssh-keygen is terminated and reported as a failed request", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	// A stand-in binary that never exits on its own: only the relay's spawn
	// timeout can end it, so a prompt error response proves the kill fired.
	const fakeDir = mkdtempSync(path.join(tmpdir(), "torus-signrelay-fakebin-"));
	const fakeKeygen = path.join(fakeDir, "ssh-keygen");
	writeFileSync(fakeKeygen, "#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n");
	chmodSync(fakeKeygen, 0o755);
	const relay = await startSignRelay({
		scratchDir: scratch,
		pollMs: 20,
		requestTimeoutMs: 400,
		sshKeygenPath: fakeKeygen,
	});
	try {
		const requestPath = path.join(relay.requestsDir, "hung.req.json");
		const startedAt = Date.now();
		writeFileSync(
			requestPath,
			JSON.stringify({
				argv: ["-Y", "sign", "-n", "git", "-f", keyring.privateKey, "payload"],
				fileContentB64: Buffer.from("hung signer payload\n").toString("base64"),
				namespace: "git",
				keyRef: keyring.privateKey,
			}),
		);
		const responsePath = path.join(scratch, "responses", "hung.resp.json");
		await waitForFile(responsePath, 8000);
		const elapsed = Date.now() - startedAt;
		const response = JSON.parse(readFileSync(responsePath, "utf8"));
		assert.equal(response.ok, false, "a hung signer must not be reported as success");
		assert.match(response.error, /ssh-keygen failed/);
		assert.match(response.error, /terminated/);
		assert.ok(elapsed >= 350, `response beat the kill timeout (${elapsed}ms)`);
		assert.ok(elapsed < 3000, `hung ssh-keygen was not killed promptly (${elapsed}ms)`);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch, fakeDir);
	}
});

test("concurrency: simultaneous requests with distinct ids each get their own verifiable signature", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	try {
		const payloadAlpha = path.join(keyring.dir, "alpha.txt");
		const payloadBeta = path.join(keyring.dir, "beta.txt");
		writeFileSync(payloadAlpha, "concurrent payload alpha\n");
		writeFileSync(payloadBeta, "concurrent payload beta\n");
		const [alpha, beta] = await Promise.all([
			runWrapper(relay, keyring.privateKey, payloadAlpha),
			runWrapper(relay, keyring.privateKey, payloadBeta),
		]);
		assert.equal(alpha.status, 0, `alpha wrapper failed:\n${alpha.stderr}`);
		assert.equal(beta.status, 0, `beta wrapper failed:\n${beta.stderr}`);
		// Distinct payloads: if a wrapper consumed the other's response, its
		// signature would not verify, so both passing proves the id mapping.
		verifySignature(payloadAlpha, keyring);
		verifySignature(payloadBeta, keyring);
		assert.deepEqual(
			readdirSync(relay.requestsDir).filter((name) => name.endsWith(".req.json")),
			[],
			"both concurrent requests must be processed and removed",
		);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});

test("atomic responses: only complete JSON is observable and temp files never linger", {
	skip: skipReason,
}, async () => {
	const keyring = makeKeyring();
	const scratch = makeScratch();
	const relay = await startSignRelay({ scratchDir: scratch, pollMs: 20 });
	const responsesDir = path.join(scratch, "responses");
	// Simulate a writer that died mid-write: rename is the only publish path,
	// so a truncated temp must never be observable as a response and must not
	// interfere with later traffic.
	const abandonedTmp = path.join(responsesDir, "abandoned.resp.json.tmp");
	const truncatedBody = '{"id":"abandoned","ok":tr';
	writeFileSync(abandonedTmp, truncatedBody);
	try {
		const payloadAlpha = path.join(keyring.dir, "direct-alpha.txt");
		const payloadBeta = path.join(keyring.dir, "direct-beta.txt");
		writeFileSync(payloadAlpha, "direct request alpha\n");
		writeFileSync(payloadBeta, "direct request beta\n");
		const writeRequest = (id, payloadPath) =>
			writeFileSync(
				path.join(relay.requestsDir, `${id}.req.json`),
				JSON.stringify({
					argv: ["-Y", "sign", "-n", "git", "-f", keyring.privateKey, payloadPath],
					fileContentB64: readFileSync(payloadPath).toString("base64"),
					namespace: "git",
					keyRef: keyring.privateKey,
				}),
			);
		writeRequest("direct-alpha", payloadAlpha);
		writeRequest("direct-beta", payloadBeta);
		await waitForFile(path.join(responsesDir, "direct-alpha.resp.json"), 10_000);
		await waitForFile(path.join(responsesDir, "direct-beta.resp.json"), 10_000);
		const responses = new Map();
		for (const id of ["direct-alpha", "direct-beta"]) {
			const response = JSON.parse(readFileSync(path.join(responsesDir, `${id}.resp.json`), "utf8"));
			assert.equal(response.id, id, "response id must match the request filename stem");
			assert.equal(response.ok, true);
			assert.equal(typeof response.signatureB64, "string");
			responses.set(id, response);
		}
		// Distinct payloads again: verifies the watcher mapped each signature
		// to the right request id.
		const pairs = [
			["direct-alpha", payloadAlpha],
			["direct-beta", payloadBeta],
		];
		for (const [id, payloadPath] of pairs) {
			writeFileSync(`${payloadPath}.sig`, Buffer.from(responses.get(id).signatureB64, "base64"));
			verifySignature(payloadPath, keyring);
		}
		// The wrapper path is unaffected by the stale temp file.
		const payload = path.join(keyring.dir, "wrapper-payload.txt");
		writeFileSync(payload, "wrapper round trip beside a stale temp\n");
		const signed = await runWrapper(relay, keyring.privateKey, payload);
		assert.equal(signed.status, 0, `wrapper failed beside a stale temp:\n${signed.stderr}`);
		// Post-run scan: every observable response parses as complete JSON,
		// nothing the relay wrote left a temp behind, and the planted stale
		// temp is untouched.
		assert.deepEqual(readdirSync(responsesDir).sort(), [
			"abandoned.resp.json.tmp",
			"direct-alpha.resp.json",
			"direct-beta.resp.json",
		]);
		for (const name of readdirSync(responsesDir)) {
			if (name.endsWith(".resp.json")) {
				JSON.parse(readFileSync(path.join(responsesDir, name), "utf8"));
			}
		}
		assert.equal(readFileSync(abandonedTmp, "utf8"), truncatedBody, "stale temp must be untouched");
		assert.deepEqual(
			listFilesRecursive(scratch).filter((file) => file.endsWith(".tmp") && file !== abandonedTmp),
			[],
			"no temp files may linger from relay writes",
		);
		assert.deepEqual(
			readdirSync(relay.requestsDir).filter((name) => name.endsWith(".req.json")),
			[],
		);
	} finally {
		await relay.stop();
		cleanup(keyring.dir, scratch);
	}
});
