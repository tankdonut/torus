import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// team-runtime pins its teams root under TORUS_HOME while the module loads,
// so the isolated home must be in place before the dynamic import below.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-protocol-"));
process.env["TORUS_HOME"] = HOME;
process.env["HOME"] = HOME;
process.env["TORUS_NOTIFY"] = "0";
process.env["TORUS_TMUX"] = "0";

const runtime = await import("../extensions/team-runtime.ts");

// Minimal RPC-mode engine double: answers every command, settles after each
// prompt, and records received prompt texts so tests can assert exactly what
// the supervisor injected (here: the role prompt carrying <team-protocol>).
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
function spawnProbe(teamId, memberName, objective) {
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
		{ name: memberName, agent: "builder" },
		objective,
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

/** The <team-protocol> block as this member received it in its first prompt. */
async function capturedProtocol(teamId, memberName, objective) {
	const { handle, promptsFile } = spawnProbe(teamId, memberName, objective);
	try {
		await waitFor("the role prompt", () => readOrEmpty(promptsFile).includes("<team-protocol>"));
		const first = readOrEmpty(promptsFile).split("===\n")[0] ?? "";
		const start = first.indexOf("<team-protocol>");
		const end = first.indexOf("</team-protocol>") + "</team-protocol>".length;
		assert.ok(start !== -1 && end > start, "the first prompt carries the protocol block");
		return first.slice(start, end);
	} finally {
		await stopProbe(handle);
	}
}

/** Expected channel lines for a member, interpolated exactly as rolePromptFor does. */
function expectedLines(teamId, memberName) {
	const mailRoot = path.join(runtime.teamDir(teamId), "mailboxes");
	return {
		inbox: `- Inbox (work arrives here): ${path.join(mailRoot, memberName, "inbox.md")}`,
		outbox: `- Outbox (your reports go here — append, never overwrite): ${path.join(mailRoot, memberName, "outbox.md")}`,
		signed:
			`- Other members' inboxes: ${mailRoot}/<member>/inbox.md — message them by appending a ` +
			"`[FROM " +
			memberName +
			"] <iso-ts>`" +
			` header line followed by your text.`,
	};
}

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("the protocol block teaches signed appends and pins every sibling line", async () => {
	const teamId = `protocol-pin-${process.pid}`;
	const block = await capturedProtocol(teamId, "alice", "test objective");
	const lines = expectedLines(teamId, "alice");

	assert.ok(block.includes(lines.signed), "the signed-append line appears verbatim");
	assert.ok(block.includes(lines.inbox), "the inbox line is unchanged");
	assert.ok(block.includes(lines.outbox), "the outbox line is unchanged");
	assert.ok(
		block.includes(
			`- Shared tasklist (JSON; claim/complete your tasks by updating it via bash/read+write): ${runtime.tasksFile(teamId)}`,
		),
		"the tasklist line is unchanged",
	);
	assert.ok(
		block.includes(
			"PROTOCOL each cycle: finish current instruction, then read your inbox for new messages.",
		),
		"the protocol paragraph is unchanged",
	);
	assert.ok(!block.includes("message them by appending there."), "the unsigned teaching is gone");
});

test("the signed-append line is unconditional: present whatever the objective carries", async () => {
	const teamId = `protocol-uncond-${process.pid}`;
	const bare = await capturedProtocol(`${teamId}-a`, "alice", "bare objective");
	const flagged = await capturedProtocol(
		`${teamId}-b`,
		"alice",
		'bare objective Claim work atomically with `node runtime/bin/team-task.mjs claim t --as <your-name>`; release with the release subcommand if you cannot finish. Send attributed teammate mail with `node runtime/bin/team-mail.mjs send t --as <your-name> --to <member> "<text>"`; list members with the members subcommand.',
	);
	const signed = expectedLines(`${teamId}-a`, "alice").signed;
	assert.ok(bare.includes(signed), "present with a bare objective");
	assert.ok(
		flagged.includes(signed.replace(`${teamId}-a`, `${teamId}-b`)),
		"present alongside flag sentences",
	);
});
