import assert from "node:assert/strict";
import { test } from "node:test";

// engine-child.ts: JSONL event parse/reduce pair + child extension args.
// parseEngineEvent/reduceEngineEvent are the same contract the RPC and JSON
// transports feed through — tally drift here corrupts every fleet readout.

const { parseEngineEvent, reduceEngineEvent, childExtensionArgs, engineChildEnv } = await import(
	"../extensions/engine-child.ts"
);

test("parseEngineEvent accepts JSON objects and rejects junk", () => {
	assert.deepEqual(parseEngineEvent('{"type":"session","id":"s1"}'), { type: "session", id: "s1" });
	assert.equal(parseEngineEvent("not json"), null);
	assert.equal(parseEngineEvent('"just a string"'), null);
	assert.equal(parseEngineEvent("null"), null);
	assert.equal(parseEngineEvent(""), null);
});

test("reduceEngineEvent tallies text blocks, turns, and cumulative usage", () => {
	const tally = { sessionId: null, turns: 0, tokensIn: 0, tokensOut: 0, text: "", exitCode: 0 };
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
				usage: { input: 10, output: 20 },
			},
		},
		tally,
	);
	assert.equal(tally.text, "hello");
	assert.equal(tally.turns, 1);
	assert.equal(tally.tokensIn, 10);
	assert.equal(tally.tokensOut, 20);
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "second turn" }],
				usage: { input: 5, output: 6 },
			},
		},
		tally,
	);
	assert.equal(tally.turns, 2);
	assert.equal(tally.text, "second turn");
	assert.equal(tally.tokensIn, 15);
	assert.equal(tally.tokensOut, 26);
});

test("reduceEngineEvent counts tool-only assistant turns and their usage", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "tool_call", id: "t1", name: "bash", arguments: {} }],
				usage: { input: 100, output: 5 },
			},
		},
		tally,
	);
	assert.equal(tally.turns, 1, "a turn without text blocks still counts");
	assert.equal(tally.tokensIn, 100, "usage from tool-only turns is tallied");
	assert.equal(tally.tokensOut, 5);
	assert.equal(tally.text, "", "no text captured from a tool-only turn");
});

test("reduceEngineEvent counts one turn per assistant message, not per text block", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "part one" },
					{ type: "text", text: "part two" },
				],
				usage: { input: 1, output: 2 },
			},
		},
		tally,
	);
	assert.equal(tally.turns, 1, "one assistant message = one turn");
	assert.equal(tally.text, "part two", "last text block still wins");
});

test("noProgressTail: progress resets it, dead turns increment it, text-only progress counts", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	const turn = (text, usage) =>
		reduceEngineEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					...(usage ? { usage } : {}),
				},
			},
			tally,
		);

	turn("working", { input: 10, output: 20 });
	assert.equal(tally.noProgressTail, 0, "a token-moving turn is progress");
	turn("working", { input: 0, output: 0 });
	assert.equal(tally.noProgressTail, 1, "zero usage delta + identical text is a dead turn");
	turn("working");
	assert.equal(tally.noProgressTail, 2, "absent usage + identical text stays dead");
	turn("fresh text only", { input: 0, output: 0 });
	assert.equal(tally.noProgressTail, 0, "a new text block alone counts as progress");
	turn("fresh text only");
	assert.equal(tally.noProgressTail, 1, "the same text replayed with no usage is dead again");
});

test("noProgressTail: tool-only turns follow the same delta rule", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	const toolTurn = (usage) =>
		reduceEngineEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "tool_call", id: "t1", name: "bash", arguments: {} }],
					usage,
				},
			},
			tally,
		);
	toolTurn({ input: 100, output: 5 });
	assert.equal(tally.noProgressTail, 0, "tool-only turn with usage is progress");
	toolTurn({ input: 0, output: 0 });
	assert.equal(tally.noProgressTail, 1, "tool-only turn with zero usage and no text is dead");
});

test("noProgressTail mirrors the observed wire pattern: identical replay adds nothing", () => {
	// Live reviewer run whose connection died mid-verdict: turns 10 and 11
	// replayed byte-identical cumulative usage (13084/2050) and byte-identical
	// partial text before the child finalized cleanly.
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	const partial = "Let me check TEAMS_ROOT resolution, then run the acceptance suite.";
	const replay = (usage) =>
		reduceEngineEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: partial }],
					usage,
				},
			},
			tally,
		);
	replay({ input: 12000, output: 2000 });
	replay({ input: 1084, output: 50 });
	assert.equal(tally.tokensIn, 13084, "cumulative input matches the observed run");
	assert.equal(tally.tokensOut, 2050, "cumulative output matches the observed run");
	assert.equal(tally.noProgressTail, 0);
	replay({ input: 0, output: 0 });
	assert.equal(tally.noProgressTail, 1, "identical cumulative usage + identical text = dead tail");
	assert.equal(tally.turns, 3, "the dead turn still counted as a turn");
});

test("lastError: error events, stopReason-error turns, and failed auto-retries all land; most recent wins", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent({ type: "error", reason: "connection", error: "fetch failed" }, tally);
	assert.equal(tally.lastError, "fetch failed", "a top-level error event sets lastError");
	reduceEngineEvent(
		{
			type: "message_update",
			usage: { input: 0, output: 0 },
			assistantMessageEvent: { type: "error", reason: "error", errorMessage: "socket hang up" },
		},
		tally,
	);
	assert.equal(tally.lastError, "socket hang up", "a message_update error event supersedes");
	reduceEngineEvent({ type: "auto_retry_end", success: true, attempt: 2 }, tally);
	assert.equal(tally.lastError, "socket hang up", "a successful retry does not touch lastError");
	reduceEngineEvent(
		{ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
		tally,
	);
	assert.equal(
		tally.lastError,
		"529 overloaded",
		"an exhausted auto-retry supersedes with its finalError",
	);
});

test("lastError: a stopReason-error turn records its errorMessage and still counts as a turn", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "connection reset",
			},
		},
		tally,
	);
	assert.equal(tally.lastError, "connection reset");
	assert.equal(tally.turns, 1, "the errored turn still counts");
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "still partial" }],
				stopReason: "error",
			},
		},
		tally,
	);
	assert.equal(
		tally.lastError,
		"connection reset",
		"a bare stopReason error keeps the earlier text",
	);
});

test("lastError: a later healthy turn clears it (the engine's retry recovered)", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent({ type: "error", error: "529 overloaded" }, tally);
	assert.equal(tally.lastError, "529 overloaded");
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "recovered and answered" }],
				usage: { input: 10, output: 20 },
				stopReason: "stop",
			},
		},
		tally,
	);
	assert.equal(
		tally.lastError,
		undefined,
		"a trailing healthy turn means the run did not end in error",
	);
});

test("lastError: healthy runs and non-assistant messages never set it", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "fine" }],
				usage: { input: 5, output: 5 },
				stopReason: "stop",
			},
		},
		tally,
	);
	assert.equal(tally.lastError, undefined);
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "no" }],
				stopReason: "error",
				errorMessage: "not an assistant",
			},
		},
		tally,
	);
	assert.equal(tally.lastError, undefined, "non-assistant messages carry no error signal here");
});

test("reduceEngineEvent ignores non-assistant and non-message_end events", () => {
	const tally = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
	};
	reduceEngineEvent({ type: "session", id: "abc" }, tally);
	reduceEngineEvent({ type: "tool_execution_start", toolName: "bash" }, tally);
	reduceEngineEvent(
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "no" }] } },
		tally,
	);
	assert.equal(tally.turns, 0);
	assert.equal(tally.text, "");
});

test("reduceEngineEvent tallies cache tokens and engine-computed cost cumulatively", () => {
	const tally = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
	};
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "one" }],
				usage: {
					input: 10,
					output: 20,
					cacheRead: 900,
					cacheWrite: 100,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0315 },
				},
			},
		},
		tally,
	);
	assert.equal(tally.cacheRead, 900);
	assert.equal(tally.cacheWrite, 100);
	assert.equal(tally.cost, 0.0315);
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "two" }],
				usage: {
					input: 5,
					output: 6,
					cacheRead: 50,
					cacheWrite: 0,
					cost: { total: 0.0085 },
				},
			},
		},
		tally,
	);
	assert.equal(tally.cacheRead, 950);
	assert.equal(tally.cacheWrite, 100);
	assert.equal(Math.round((tally.cost - 0.04) * 1e9), 0, "cost accumulates across turns");
});

test("absent or malformed cost never poisons the tally with NaN", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "no cost object" }],
				usage: { input: 7, output: 8 },
			},
		},
		tally,
	);
	assert.ok(Number.isFinite(tally.cost), "usage without cost yields a finite cost");
	assert.equal(tally.cost, 0);
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "garbage cost" }],
				usage: { input: 1, output: 1, cost: { total: Number.NaN } },
			},
		},
		tally,
	);
	assert.ok(Number.isFinite(tally.cost), "non-finite cost.total must not leak NaN");
	assert.equal(tally.cost, 0);
	reduceEngineEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "string cost" }],
				usage: { input: 1, output: 1, cost: "free" },
			},
		},
		tally,
	);
	assert.ok(Number.isFinite(tally.cost));
	assert.equal(tally.cost, 0);
	assert.ok(Number.isFinite(tally.cacheRead), "absent cache fields stay finite too");
	assert.equal(tally.cacheRead, 0);
});

test("childExtensionArgs includes every composed extension that exists in the repo layout", () => {
	const args = childExtensionArgs(process.cwd());
	const flat = args.join(" ");
	assert.ok(flat.includes("extensions/mcp"), "mcp extension missing from children");
	assert.ok(flat.includes("cc-safety-net"), "cc-safety-net missing from children");
	assert.ok(flat.includes("pi-web-access"), "pi-web-access missing from children");
	assert.ok(flat.includes("pi-lsp-client"), "pi-lsp-client missing from children");
	for (const arg of args) {
		assert.ok(!arg.includes("undefined"), `unresolved path leaked into args: ${arg}`);
		assert.ok(!arg.includes("null"), `null leaked into args: ${arg}`);
	}
});

test("engineChildEnv marks the child without clobbering inherited env", () => {
	// hermetic under delegation children: ambient marker must be absent for this check
	const ambient = process.env["TORUS_ENGINE_CHILD"];
	delete process.env["TORUS_ENGINE_CHILD"];
	process.env["TORUS_TEST_MARKER"] = "present";
	try {
		const env = engineChildEnv();
		assert.equal(env["TORUS_ENGINE_CHILD"], "1");
		assert.equal(env["TORUS_TEST_MARKER"], "present");
		assert.equal(process.env["TORUS_ENGINE_CHILD"], undefined, "parent env untouched");
	} finally {
		delete process.env["TORUS_TEST_MARKER"];
		if (ambient !== undefined) process.env["TORUS_ENGINE_CHILD"] = ambient;
	}
});
