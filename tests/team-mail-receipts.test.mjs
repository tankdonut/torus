import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// team-runtime pins its teams root under TORUS_HOME while the module loads,
// so the isolated home must be in place before the dynamic import below.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-mail-receipts-"));
process.env["TORUS_HOME"] = HOME;
process.env["HOME"] = HOME;
process.env["TORUS_NOTIFY"] = "0";
process.env["TORUS_TMUX"] = "0";

const runtime = await import("../extensions/team-runtime.ts");

const STAMP = "[2026-10-29T00:00:00.000Z]";

// Minimal RPC-mode engine double: answers every command, settles after each
// prompt, and records received prompt texts so tests can assert exactly what
// the supervisor injected. Embedded as a plain template literal, so every
// backslash the script itself needs is doubled below.
const FAKE_ENGINE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const promptsFile = process.env["FAKE_ENGINE_PROMPTS"] ?? "/dev/null";
let buffer = "";

const handleLine = (line) => {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (command.type !== "get_state" && command.type !== "prompt" && command.type !== "steer") {
		return;
	}
	if (command.type !== "get_state") {
		appendFileSync(promptsFile, command.type + ": " + command.message + "\\n===\\n", "utf8");
	}
	const response = JSON.stringify({
		type: "response",
		id: command.id,
		data: { sessionId: "fake-session" },
	});
	process.stdout.write(response + "\\n");
	if (command.type !== "get_state") {
		process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
	}
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		handleLine(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\\n");
	}
});
process.stdin.on("end", () => process.exit(0));
`;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOrEmpty(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

async function waitFor(label, predicate) {
	const deadline = Date.now() + 30_000;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(`${label} never happened within 30s`);
		await sleep(100);
	}
}

/** Real spawnMember under the fake RPC engine; the caller must stop the handle. */
function spawnProbe(teamId) {
	const engineDir = path.join(HOME, "engines", teamId);
	mkdirSync(engineDir, { recursive: true });
	const engine = path.join(engineDir, "engine.mjs");
	const promptsFile = path.join(engineDir, "prompts.log");
	writeFileSync(engine, FAKE_ENGINE, "utf8");
	chmodSync(engine, 0o755);

	process.env["FAKE_ENGINE_PROMPTS"] = promptsFile;
	const previousBin = process.env["TORUS_ENGINE_BIN"];
	process.env["TORUS_ENGINE_BIN"] = engine;
	const handle = runtime.spawnMember(
		teamId,
		{ name: "probe", agent: "builder" },
		"test objective",
		() => {},
		() => {},
	);
	if (previousBin === undefined) delete process.env["TORUS_ENGINE_BIN"];
	else process.env["TORUS_ENGINE_BIN"] = previousBin;
	return { handle, promptsFile };
}

async function stopProbe(handle) {
	handle.stop();
	await handle.exited;
}

function countMatches(text, needle) {
	return (text.match(needle) ?? []).length;
}

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("an inbox rewrite that keeps consumed bytes delivers no delta and pins the cursor", () => {
	const dir = path.join(HOME, "unit", "rewrite-keeps-bytes");
	mkdirSync(dir, { recursive: true });
	const inbox = path.join(dir, "inbox.md");
	const cursorFile = path.join(dir, "inbox.cursor");
	const first = `\n${STAMP} FROM lead:\nfirst brief\n`;
	const second = `\n${STAMP} FROM bob:\nsecond brief\n`;
	writeFileSync(inbox, first + second, "utf8");
	const cursor = { value: statSync(inbox).size };

	// The rewrite keeps the first brief verbatim but drops the second: the
	// bytes that survive were already consumed, so nothing may come back.
	writeFileSync(inbox, first, "utf8");
	const shrinks = [];
	runtime._resetDeltaBytesReadForTesting();
	assert.equal(
		runtime.readDelta(inbox, cursor, cursorFile, (n) => shrinks.push(n)),
		"",
	);
	assert.deepEqual(shrinks, [second.length], "the shrink reports the vanished byte count");
	assert.equal(cursor.value, first.length, "the cursor pins to the new size");
	assert.equal(readFileSync(cursorFile, "utf8"), String(first.length));
	assert.equal(runtime._deltaBytesReadForTesting(), 0, "a shrunk inbox is never re-read");
	assert.equal(
		runtime.readDelta(inbox, cursor, cursorFile),
		"",
		"the rewritten inbox stays silent",
	);
});

test("an inbox truncated to zero delivers nothing until fresh bytes land", () => {
	const dir = path.join(HOME, "unit", "truncate-to-zero");
	mkdirSync(dir, { recursive: true });
	const inbox = path.join(dir, "inbox.md");
	const cursorFile = path.join(dir, "inbox.cursor");
	const first = `\n${STAMP} FROM lead:\nfirst brief\n`;
	const second = `\n${STAMP} FROM bob:\nsecond brief\n`;
	writeFileSync(inbox, first + second, "utf8");
	const cursor = { value: statSync(inbox).size };

	writeFileSync(inbox, "", "utf8");
	assert.equal(runtime.readDelta(inbox, cursor, cursorFile), "", "truncation delivers no delta");
	assert.equal(cursor.value, 0);
	assert.equal(readFileSync(cursorFile, "utf8"), "0");

	const fresh = `\n${STAMP} FROM lead:\nfresh brief\n`;
	appendFileSync(inbox, fresh, "utf8");
	assert.equal(
		runtime.readDelta(inbox, cursor, cursorFile),
		fresh,
		"only post-truncation bytes arrive",
	);
	assert.equal(readFileSync(cursorFile, "utf8"), String(fresh.length));
});

test("a deliverMail-stamped delta receipts as mail from the sender in the member log", async () => {
	const teamId = `receipts-stamped-${process.pid}`;
	const { handle } = spawnProbe(teamId);
	const logFile = path.join(runtime.teamDir(teamId), "probe.log");
	try {
		const inbox = path.join(handle.mailboxDir, "inbox.md");
		const before = statSync(inbox).size;
		runtime.deliverMail(teamId, "probe", "lead", "do the thing");
		const delivered = statSync(inbox).size - before;
		await waitFor("the stamped receipt", () =>
			readOrEmpty(logFile).includes(`mail from lead: ${delivered} bytes`),
		);
		const log = readFileSync(logFile, "utf8");
		assert.equal(countMatches(log, /mail from lead: \d+ bytes/g), 1);
		assert.ok(!log.includes("do the thing"), "receipts never quote mail content");
	} finally {
		await stopProbe(handle);
	}
});

test("an unsigned raw append receipts as unattributed", async () => {
	const teamId = `receipts-unsigned-${process.pid}`;
	const { handle } = spawnProbe(teamId);
	const logFile = path.join(runtime.teamDir(teamId), "probe.log");
	try {
		const inbox = path.join(handle.mailboxDir, "inbox.md");
		const raw = "\nloose chatter with no sender stamp\n";
		appendFileSync(inbox, raw, "utf8");
		await waitFor("the unattributed receipt", () =>
			readOrEmpty(logFile).includes(`mail from unattributed: ${raw.length} bytes`),
		);
		const log = readFileSync(logFile, "utf8");
		assert.ok(!log.includes("mail from lead:"), "no sender is invented for a raw append");
		assert.ok(!log.includes("loose chatter"), "receipts never quote mail content");
	} finally {
		await stopProbe(handle);
	}
});

test("a mid-run inbox shrink warns exactly once and re-delivers nothing", async () => {
	const teamId = `receipts-shrink-${process.pid}`;
	const { handle, promptsFile } = spawnProbe(teamId);
	const logFile = path.join(runtime.teamDir(teamId), "probe.log");
	const inbox = path.join(handle.mailboxDir, "inbox.md");
	const cursorFile = path.join(handle.mailboxDir, "inbox.cursor");
	const first = `\n${STAMP} FROM lead:\nfirst brief\n`;
	const second = `\n${STAMP} FROM lead:\nsecond brief\n`;
	const third = `\n${STAMP} FROM lead:\npost-rewrite brief\n`;
	try {
		appendFileSync(inbox, first, "utf8");
		await waitFor("the first receipt", () => readOrEmpty(logFile).includes("mail from lead:"));
		appendFileSync(inbox, second, "utf8");
		await waitFor(
			"the second receipt",
			() => countMatches(readOrEmpty(logFile), /mail from lead: \d+ bytes/g) >= 2,
		);

		// Rewrite keeps the consumed first brief and drops the second: the
		// vanished window must never come back as NEW MAIL.
		writeFileSync(inbox, first, "utf8");
		await waitFor("the shrink warning", () =>
			readOrEmpty(logFile).includes(`inbox shrank unexpectedly: skipped ${second.length} bytes`),
		);
		await sleep(2600);
		let log = readFileSync(logFile, "utf8");
		assert.equal(
			countMatches(log, /inbox shrank unexpectedly/g),
			1,
			"one warning per shrink event",
		);
		assert.equal(
			countMatches(readOrEmpty(promptsFile), /second brief/g),
			1,
			"the consumed brief is injected once and never re-delivered",
		);
		assert.equal(readFileSync(cursorFile, "utf8"), String(first.length));

		// Appends after the rewrite arrive, and a second shrink warns again.
		appendFileSync(inbox, third, "utf8");
		await waitFor(
			"the post-rewrite receipt",
			() => countMatches(readOrEmpty(logFile), /mail from lead: \d+ bytes/g) >= 3,
		);
		writeFileSync(inbox, "", "utf8");
		await waitFor("the second shrink warning", () =>
			readOrEmpty(logFile).includes(`skipped ${first.length + third.length} bytes`),
		);
		await sleep(2600);
		log = readFileSync(logFile, "utf8");
		assert.equal(
			countMatches(log, /inbox shrank unexpectedly/g),
			2,
			"each shrink event warns exactly once",
		);
		assert.equal(readFileSync(cursorFile, "utf8"), "0");
	} finally {
		await stopProbe(handle);
	}
});
