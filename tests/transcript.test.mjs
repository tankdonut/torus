import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// transcript.ts session-file parsing: suffix matching against
// <timestamp>_<uuid>.jsonl names, block shapes (toolCall/arguments,
// role-toolResult with toolCallId pairing), malformed-line tolerance.
// Fixtures are planted in a temp slug dir under an isolated agent home
// (PI_CODING_AGENT_DIR) because findSessionFile scans <agentDir>/sessions/
// <slug>/ by suffix — the dashed-vs-dotted slug lesson is pinned here —
// and nothing may write the real ~/.pi/agent/sessions (sandbox hermeticity).
const AGENT_DIR = mkdtempSync(path.join(tmpdir(), "torus-transcript-agent-"));
process.env["PI_CODING_AGENT_DIR"] = AGENT_DIR;
const SESSIONS = path.join(AGENT_DIR, "sessions");
const SLUG = "torus-test-transcript";
const DIR = path.join(SESSIONS, SLUG);

const { _transcriptStats, liveTail, transcriptItems } = await import("../extensions/transcript.ts");

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

test("toolResult details surface on the paired tool item", () => {
	const id = `${UUID}-e`;
	plantSession(id, [
		JSON.stringify({
			type: "message",
			id: "d1",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tcD",
						name: "edit",
						arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
					},
				],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "d2",
			message: {
				role: "toolResult",
				toolCallId: "tcD",
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
				details: { diff: "- x\n+ y", firstChangedLine: 1, patch: "@@ -1 +1 @@" },
			},
		}),
	]);
	const tool = transcriptItems(id, 40).find((i) => i.kind === "tool" && i.toolCallId === "tcD");
	assert.ok(tool && tool.kind === "tool", "edit toolCall item missing");
	if (tool && tool.kind === "tool") {
		assert.deepEqual(tool.details, { diff: "- x\n+ y", firstChangedLine: 1, patch: "@@ -1 +1 @@" });
	}
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

test("mirrored torus.work-ledger custom entries render a compact ledger line", () => {
	const id = `${UUID}-led`;
	plantSession(id, [
		JSON.stringify({ type: "session", id, timestamp: Date.now(), cwd: "/tmp" }),
		JSON.stringify({
			type: "custom",
			customType: "torus.work-ledger",
			data: {
				ts: "2026-10-07T00:00:00.000Z",
				sessionId: id,
				event: "task-done",
				text: "T1 done: shipped the thing, tests green",
			},
		}),
		JSON.stringify({
			type: "custom",
			customType: "torus.work-ledger",
			data: { event: "note", text: "x".repeat(300) },
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			message: { role: "user", content: [{ type: "text", text: "after the mirror rows" }] },
		}),
	]);
	const items = transcriptItems(id, 40);
	const ledgers = items.filter((i) => i.kind === "tool" && i.name === "ledger");
	assert.equal(ledgers.length, 2, "one ledger line per mirrored row");
	assert.deepEqual(ledgers[0].args, {
		event: "task-done",
		text: "T1 done: shipped the thing, tests green",
	});
	assert.equal(ledgers[1].args.event, "note");
	assert.equal(ledgers[1].args.text.length, 120, "text truncated to the compact preview");
	assert.ok(
		items.some((i) => i.kind === "user"),
		"regular kinds still render",
	);
});

test("custom entries of other customTypes render nothing", () => {
	const id = `${UUID}-other`;
	plantSession(id, [
		JSON.stringify({ type: "custom", customType: "pi.virtual-model-state", data: { mode: "m" } }),
		JSON.stringify({ type: "custom", customType: "codemode-store", data: { runs: [] } }),
		...baseSession(id),
	]);
	const items = transcriptItems(id, 40);
	assert.equal(
		items.filter((i) => i.kind === "tool" && i.name === "ledger").length,
		0,
		"foreign custom entries produce no items",
	);
	const tool = items.find((i) => i.kind === "tool" && i.toolCallId === "tc1");
	assert.ok(tool, "existing kinds unaffected");
	if (tool && tool.kind === "tool") assert.equal(tool.output, "total 0");
});

const stats = () => _transcriptStats();

function sessionFile(id) {
	return path.join(DIR, `2026-09-30T00-00-00-000Z_${id}.jsonl`);
}

test("incremental parse: an appended line is the only thing parsed and old items keep identity", () => {
	const id = `${UUID}-inc`;
	plantSession(id, baseSession(id));
	const before = stats();
	const first = transcriptItems(id, 100);
	const afterFull = stats();
	assert.equal(afterFull.fullReparses - before.fullReparses, 1, "first call is a full parse");
	assert.ok(afterFull.linesParsed > first.length, "every fixture line went through the parser");

	appendFileSync(
		sessionFile(id),
		`${JSON.stringify({ type: "message", id: "m9", message: { role: "user", content: [{ type: "text", text: "appended turn" }] } })}\n`,
		"utf8",
	);
	const second = transcriptItems(id, 100);
	const afterAppend = stats();
	assert.equal(
		afterAppend.fullReparses,
		afterFull.fullReparses,
		"append must not trigger a full reparse",
	);
	assert.equal(
		afterAppend.linesParsed - afterFull.linesParsed,
		1,
		"only the appended line is parsed",
	);
	assert.equal(second.length, first.length + 1, "appended record renders");
	assert.equal(second.at(-1)?.text, "appended turn");
	for (let i = 0; i < first.length; i += 1) {
		assert.ok(first[i] === second[i], `item ${i} must keep its object identity across appends`);
	}
});

test("interleaved tool results resolve exactly as the reverse-scan parse did", () => {
	const id = `${UUID}-map`;
	const toolCall = (tcId, name) =>
		JSON.stringify({
			type: "message",
			id: `a-${tcId}`,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: tcId, name, arguments: {} }],
			},
		});
	const result = (tcId, text, extra = {}) =>
		JSON.stringify({
			type: "message",
			id: `r-${tcId}-${text}`,
			message: {
				role: "toolResult",
				...(tcId ? { toolCallId: tcId } : {}),
				content: [{ type: "text", text }],
				...extra,
			},
		});
	plantSession(id, [
		JSON.stringify({ type: "session", id, timestamp: Date.now(), cwd: "/tmp" }),
		toolCall("tcA", "bash"),
		toolCall("tcB", "read"),
		result(undefined, "out B"),
		result(undefined, "out A"),
		toolCall("tcC", "grep"),
		result("tcGHOST", "orphan"),
		result("tcC", "out C", { isError: true, details: { diff: "-a\n+b" } }),
		toolCall("tcD", "ls"),
		result("tcD", "first"),
		result("tcD", "second"),
	]);
	const byId = Object.fromEntries(
		transcriptItems(id, 100)
			.filter((i) => i.kind === "tool")
			.map((i) => [i.toolCallId, i]),
	);
	// Id-less results attach newest-open-first (B before A); the ghost id is
	// dropped; a repeated id overwrites; every attach stamps isError.
	assert.equal(byId.tcB.output, "out B");
	assert.equal(byId.tcA.output, "out A");
	assert.equal(byId.tcA.isError, false);
	assert.equal(byId.tcC.output, "out C");
	assert.equal(byId.tcC.isError, true);
	assert.deepEqual(byId.tcC.details, { diff: "-a\n+b" });
	assert.equal(byId.tcD.output, "second");
	assert.equal(Object.keys(byId).length, 4, "the orphan result must not mint an item");

	// The matching maps survive into the incremental pass: append a call and
	// its result, and the result resolves without a full reparse.
	const before = stats();
	const firstItems = transcriptItems(id, 100);
	appendFileSync(sessionFile(id), `${toolCall("tcE", "find")}\n${result("tcE", "late")}\n`, "utf8");
	const items = transcriptItems(id, 100);
	assert.equal(stats().fullReparses, before.fullReparses, "append resolves incrementally");
	const late = items.find((i) => i.kind === "tool" && i.toolCallId === "tcE");
	assert.ok(late, "appended call renders");
	assert.equal(late.output, "late", "appended result pairs through the carried map");
	for (let i = 0; i < firstItems.length; i += 1) {
		assert.ok(firstItems[i] === items[i], "prior items keep identity through the append");
	}
});

test("a transcript line without its trailing newline stays invisible until completed", () => {
	const id = `${UUID}-partial`;
	mkdirSync(DIR, { recursive: true });
	const file = sessionFile(id);
	const sessionLine = JSON.stringify({ type: "session", id, timestamp: Date.now(), cwd: "/tmp" });
	const userLine = JSON.stringify({
		type: "message",
		id: "p1",
		message: { role: "user", content: [{ type: "text", text: "partial writer" }] },
	});
	writeFileSync(file, `${sessionLine}\n${userLine}`, "utf8");
	assert.equal(transcriptItems(id, 100).length, 0, "unterminated line must not render");

	const reply = JSON.stringify({
		type: "message",
		id: "p2",
		message: { role: "assistant", content: [{ type: "text", text: "completed" }] },
	});
	appendFileSync(file, `\n${reply}\n`, "utf8");
	const items = transcriptItems(id, 100);
	assert.equal(
		items.filter((i) => i.kind === "user").length,
		1,
		"completed line renders exactly once",
	);
	assert.ok(items.some((i) => i.kind === "user" && i.text === "partial writer"));
	assert.ok(
		items.some((i) => i.kind === "assistant"),
		"the record after the completed line renders too",
	);
});

test("cleanup: planted fixtures removed", () => {
	rmSync(AGENT_DIR, { recursive: true, force: true });
	assert.equal(transcriptItems(UUID, 40).length, 0);
});
