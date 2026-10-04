import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// transcript.ts session-file parsing: suffix matching against
// <timestamp>_<uuid>.jsonl names, block shapes (toolCall/arguments,
// role-toolResult with toolCallId pairing), malformed-line tolerance.
// Fixtures are planted in a temp slug dir under the REAL sessions root
// because findSessionFile scans ~/.pi/agent/sessions/<slug>/ by suffix —
// the dashed-vs-dotted slug lesson is pinned here.

const SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");
const SLUG = "torus-test-transcript";
const DIR = path.join(SESSIONS, SLUG);

const { transcriptItems, liveTail } = await import("../extensions/transcript.ts");

const UUID = "0f0e0d0c-1111-2222-3333-444455556666";

function plantSession(sessionId, lines) {
	mkdirSync(DIR, { recursive: true });
	const file = path.join(DIR, `2026-09-30T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

function baseSession(id) {
	return [
		JSON.stringify({ type: "session", id, timestamp: Date.now(), cwd: "/tmp" }),
		JSON.stringify({
			type: "message",
			id: "m1",
			message: { role: "user", content: [{ type: "text", text: "the structure of this repo" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "considering" },
					{ type: "text", text: "Scanning the repo layout." },
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls -la" } },
				],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "m3",
			message: {
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "total 0" }],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "m4",
			message: { role: "assistant", content: [{ type: "text", text: "It is empty." }] },
		}),
	];
}

test("finds session by uuid suffix in <timestamp>_<uuid>.jsonl names and pairs tool results", () => {
	plantSession(UUID, baseSession(UUID));
	const items = transcriptItems(UUID, 40);
	assert.ok(items.length >= 3, `expected >=3 items, got ${items.length}`);
	const user = items.find((i) => i.kind === "user");
	assert.equal(user && user.kind === "user" ? user.text : "", "the structure of this repo");
	const tool = items.find((i) => i.kind === "tool" && i.toolCallId === "tc1");
	assert.ok(tool, "toolCall item missing");
	if (tool && tool.kind === "tool") {
		assert.equal(tool.name, "bash");
		assert.deepEqual(tool.args, { command: "ls -la" });
		assert.equal(tool.output, "total 0");
		assert.equal(tool.isError, false);
	}
});

test("toolResult without a matching toolCall is dropped, not paired to the wrong call", () => {
	const id = `${UUID}-b`;
	const lines = [
		JSON.stringify({
			type: "message",
			id: "x1",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tcA", name: "read", arguments: { path: "/a" } }],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "x2",
			message: {
				role: "toolResult",
				toolCallId: "tcGHOST",
				content: [{ type: "text", text: "orphan" }],
			},
		}),
	];
	plantSession(id, lines);
	const tool = transcriptItems(id, 40).find((i) => i.kind === "tool");
	assert.ok(
		tool && tool.kind === "tool" && tool.output === undefined,
		"orphan result must not attach",
	);
});

test("malformed and empty lines are tolerated mid-file", () => {
	const id = `${UUID}-c`;
	const good = baseSession(id);
	plantSession(id, ["{not json", "", good[1], good[2]]);
	const items = transcriptItems(id, 40);
	assert.ok(items.length >= 1);
});

test("error tool results flag isError", () => {
	const id = `${UUID}-d`;
	plantSession(id, [
		JSON.stringify({
			type: "message",
			id: "e1",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tcE", name: "bash", arguments: { command: "false" } }],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "e2",
			message: {
				role: "toolResult",
				toolCallId: "tcE",
				isError: true,
				content: [{ type: "text", text: "boom" }],
			},
		}),
	]);
	const tool = transcriptItems(id, 40).find((i) => i.kind === "tool");
	assert.ok(tool && tool.kind === "tool" && tool.isError === true);
});

test("liveTail returns non-empty tail lines from a real log", () => {
	const log = path.join(tmpdir(), `torus-test-livetail-${Date.now()}.log`);
	writeFileSync(
		log,
		["[ts] delegate explore (m) start", "", "→ bash ls", "← result", ""].join("\n"),
		"utf8",
	);
	assert.deepEqual(liveTail(log, 10), ["[ts] delegate explore (m) start", "→ bash ls", "← result"]);
	assert.deepEqual(liveTail(log, 2), ["→ bash ls", "← result"]);
	rmSync(log, { force: true });
});

test("cleanup: planted fixtures removed", () => {
	rmSync(DIR, { recursive: true, force: true });
	assert.equal(transcriptItems(UUID, 40).length, 0);
});
