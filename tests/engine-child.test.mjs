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

test("reduceEngineEvent ignores non-assistant and non-message_end events", () => {
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent({ type: "session", id: "abc" }, tally);
	reduceEngineEvent({ type: "tool_execution_start", toolName: "bash" }, tally);
	reduceEngineEvent(
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "no" }] } },
		tally,
	);
	assert.equal(tally.turns, 0);
	assert.equal(tally.text, "");
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
