import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { memberMailbox, memberModelCandidates, spawnMember } = await import(
	"../extensions/team/team-runtime.ts"
);

test("supervisor seeds the inbox cursor to cover pre-spawn mail", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-member-cursor-"));
	const fakeEngine = path.join(dir, "exit-engine.sh");
	writeFileSync(fakeEngine, "#!/bin/sh\nexit 1\n", "utf8");
	chmodSync(fakeEngine, 0o755);

	const previousBin = process.env.TORUS_ENGINE_BIN;
	process.env.TORUS_ENGINE_BIN = fakeEngine;
	const teamId = `cursor-probe-${process.pid}`;
	try {
		// Mail that predates the supervisor (delivered between team_create and
		// the first cycle) is read directly by the member's FIRST INSTRUCTION;
		// the drain cursor must start past it so NEW MAIL never re-injects it.
		const mailboxDir = memberMailbox(teamId, "probe");
		const inboxFile = path.join(mailboxDir, "inbox.md");
		appendFileSync(inboxFile, "[2026-10-02T00:00:00.000Z] FROM lead:\nold brief\n", "utf8");

		const handle = spawnMember(
			teamId,
			{ name: "probe", agent: "builder" },
			"test objective",
			() => {},
			() => {},
		);
		await handle.exited;

		const seeded = readFileSync(path.join(mailboxDir, "inbox.cursor"), "utf8").trim();
		const inboxLength = readFileSync(inboxFile, "utf8").length.toString();
		assert.equal(seeded, inboxLength, "cursor covers all pre-spawn inbox content");
	} finally {
		if (previousBin === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = previousBin;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("memberModelCandidates: explicit model first, deduped, chain fallback for known and unknown agents", async () => {
	const explicit = memberModelCandidates({
		name: "probe",
		agent: "builder",
		model: "zai/glm-5.3-flash",
	});
	assert.equal(explicit[0], "zai/glm-5.3-flash", "explicit model leads the candidates");
	assert.ok(new Set(explicit).size === explicit.length, "no duplicate models");
	assert.ok(
		explicit.includes("zai/glm-5.3"),
		"primary chain head reachable after the explicit model",
	);

	const known = memberModelCandidates({ name: "probe", agent: "explorer" });
	assert.equal(
		known[0],
		known.find((m) => m.includes("flash")),
		"fast-chain agent leads with a flash model",
	);

	const unknown = memberModelCandidates({ name: "probe", agent: "free-text role" });
	assert.equal(
		unknown[0],
		"zai/glm-5.3-flash",
		"unknown agents fall back to the default member model",
	);
	assert.ok(unknown.includes("zai/glm-5.3"), "primary chain backs an unknown role");
});

test("spawnMember walks the model chain when the engine dies with zero work", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-member-fallback-"));
	const fakeEngine = path.join(dir, "fail-engine.sh");
	writeFileSync(fakeEngine, "#!/bin/sh\nexit 1\n", "utf8");
	chmodSync(fakeEngine, 0o755);

	const previousBin = process.env.TORUS_ENGINE_BIN;
	process.env.TORUS_ENGINE_BIN = fakeEngine;
	const teamId = `fallback-probe-${process.pid}`;
	const states = [];
	try {
		const handle = spawnMember(
			teamId,
			{ name: "probe", agent: "builder" },
			"test objective",
			(state) => states.push(state.status),
			() => {},
		);
		await handle.exited;
		const log = readFileSync(path.join(handle.mailboxDir, "..", "..", "probe.log"), "utf8");
		const fallbacks = (log.match(/falling back to/g) ?? []).length;
		const candidates = memberModelCandidates({ name: "probe", agent: "builder" });
		assert.equal(
			fallbacks,
			candidates.length - 1,
			"every candidate after the head got one fallback attempt",
		);
		assert.match(log, /produced no work \(.*\) — falling back to/, "fallback reason logged");
		assert.match(log, /member stopped/, "member reached terminal state");
		assert.ok(states.includes("stopped"), "stop state observed");
	} finally {
		if (previousBin === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = previousBin;
		rmSync(path.join(process.env.HOME ?? tmpdir(), ".torus", "teams", teamId), {
			recursive: true,
			force: true,
		});
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run that settles with an error turn still walks the chain", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-member-errorturn-"));
	// An RPC-speaking engine: answers get_state, answers each prompt with ONE
	// failed assistant turn (429-style) plus agent_settled, and stays alive.
	// The engine settles a quota-stormed run exactly like a real answer, so
	// raw turn counts prove nothing — the supervisor must judge the dead tail
	// and walk instead of idling on a dead model.
	const fakeEngine = path.join(dir, "error-turn-engine.mjs");
	writeFileSync(
		fakeEngine,
		[
			"#!/usr/bin/env node",
			'import { createInterface } from "node:readline";',
			"const rl = createInterface({ input: process.stdin });",
			'const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
			'rl.on("line", (line) => {',
			"  let record;",
			"  try { record = JSON.parse(line); } catch { return; }",
			'  if (record.type === "get_state") {',
			'    send({ type: "response", id: record.id, result: { sessionId: "sess-error-turn" } });',
			'  } else if (record.type === "prompt") {',
			'    send({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 weekly limit exhausted", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });',
			'    send({ type: "agent_settled" });',
			'    send({ type: "response", id: record.id, result: {} });',
			"  } else {",
			'    send({ type: "response", id: record.id, result: {} });',
			"  }",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(fakeEngine, 0o755);

	const previousBin = process.env.TORUS_ENGINE_BIN;
	process.env.TORUS_ENGINE_BIN = fakeEngine;
	const teamId = `error-turn-probe-${process.pid}`;
	try {
		const handle = spawnMember(
			teamId,
			{ name: "probe", agent: "builder" },
			"test objective",
			() => {},
			() => {},
		);
		// stop the member once the walk is visible; the fake engine never exits
		const deadline = Date.now() + 10_000;
		const logPath = path.join(handle.mailboxDir, "..", "..", "probe.log");
		while (Date.now() < deadline) {
			let log = "";
			try {
				log = readFileSync(logPath, "utf8");
			} catch {}
			if ((log.match(/falling back to/g) ?? []).length >= 2) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		handle.stop();
		await handle.exited;
		const log = readFileSync(logPath, "utf8");
		assert.match(
			log,
			/produced no work \(429 weekly limit exhausted\) — falling back to/,
			"the error-turn bootstrap walked instead of idling",
		);
		assert.equal(log.includes("member engine died mid-work"), false, "no healthy work to protect");
	} finally {
		if (previousBin === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = previousBin;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a child that dies after real work is still protected from respawn", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-member-realwork-"));
	const fakeEngine = path.join(dir, "realwork-engine.sh");
	writeFileSync(
		fakeEngine,
		'#!/bin/sh\nprintf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"did the work"}],"usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0}}}\'\nexit 1\n',
		"utf8",
	);
	chmodSync(fakeEngine, 0o755);

	const previousBin = process.env.TORUS_ENGINE_BIN;
	process.env.TORUS_ENGINE_BIN = fakeEngine;
	const teamId = `realwork-probe-${process.pid}`;
	try {
		const handle = spawnMember(
			teamId,
			{ name: "probe", agent: "builder" },
			"test objective",
			() => {},
			() => {},
		);
		await handle.exited;
		const log = readFileSync(path.join(handle.mailboxDir, "..", "..", "probe.log"), "utf8");
		assert.match(log, /member engine died mid-work after 1 turns — not retrying/);
		assert.equal(log.includes("falling back to"), false, "real work is never respawned over");
	} finally {
		if (previousBin === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = previousBin;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a mail run that dies on its model rotates the member onto the next candidate", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-member-rotate-"));
	// Per-process prompt counter: each spawned child answers its FIRST prompt
	// (bootstrap or replayed mail) with a healthy turn and every later prompt
	// with a quota-style 429 error turn — the model dies exactly mid-life.
	const fakeEngine = path.join(dir, "rotate-engine.mjs");
	writeFileSync(
		fakeEngine,
		[
			"#!/usr/bin/env node",
			'import { createInterface } from "node:readline";',
			"const rl = createInterface({ input: process.stdin });",
			'const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
			"let prompts = 0;",
			'rl.on("line", (line) => {',
			"  let record;",
			"  try { record = JSON.parse(line); } catch { return; }",
			'  if (record.type === "get_state") {',
			'	 send({ type: "response", id: record.id, result: { sessionId: "sess-rotate-" + process.pid } });',
			'  } else if (record.type === "prompt") {',
			"    prompts += 1;",
			"    if (prompts === 1) {",
			'      send({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "handled" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } });',
			"    } else {",
			'      send({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 weekly limit exhausted", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });',
			"    }",
			'    send({ type: "agent_settled" });',
			'    send({ type: "response", id: record.id, result: {} });',
			"  } else {",
			'    send({ type: "response", id: record.id, result: {} });',
			"  }",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(fakeEngine, 0o755);

	const previousBin = process.env.TORUS_ENGINE_BIN;
	process.env.TORUS_ENGINE_BIN = fakeEngine;
	const teamId = `rotate-probe-${process.pid}`;
	try {
		const states = [];
		const handle = spawnMember(
			teamId,
			{ name: "probe", agent: "builder" },
			"test objective",
			(state) => states.push(state.status),
			() => {},
		);
		const logPath = path.join(handle.mailboxDir, "..", "..", "probe.log");
		// wait for the bootstrap to settle and the member to idle
		const idleDeadline = Date.now() + 15_000;
		while (Date.now() < idleDeadline && !states.includes("idle")) {
			await new Promise((r) => setTimeout(r, 100));
		}
		// deliver mail: the run on the head model dies, the supervisor rotates
		const mailboxDir = memberMailbox(teamId, "probe");
		appendFileSync(
			path.join(mailboxDir, "inbox.md"),
			"[2026-11-13T00:00:00.000Z] FROM lead:\ndo the thing\n",
			"utf8",
		);
		const rotateDeadline = Date.now() + 20_000;
		let rotated = false;
		while (Date.now() < rotateDeadline) {
			let log = "";
			try {
				log = readFileSync(logPath, "utf8");
			} catch {}
			rotated = /rotating to /.test(log);
			if (rotated) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		handle.stop();
		await handle.exited;
		const log = readFileSync(logPath, "utf8");
		assert.ok(rotated, "the dead mail run rotated the member");
		assert.match(log, /429 weekly limit exhausted\) — rotating to zai\/glm-5\.3/);
		assert.equal(
			log.includes("chain exhausted, member idle"),
			false,
			"the replay found a live model",
		);
		assert.ok(
			states.filter((s) => s === "working").length >= 2,
			"the member went back to work on the rotated model",
		);
	} finally {
		if (previousBin === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = previousBin;
		rmSync(dir, { recursive: true, force: true });
	}
});
