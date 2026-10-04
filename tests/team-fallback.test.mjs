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
	"../extensions/team-runtime.ts"
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
		assert.match(log, /produced no work — falling back to/, "fallback reason logged");
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
