import assert from "node:assert/strict";
import { test } from "node:test";

// consumeEventLine must turn both tool-activity sources the engine emits into
// action lines: dedicated tool_execution_* events (RPC mode) and camelCase
// toolCall blocks / toolResult-role messages inside message_end (both modes),
// deduped per toolCallId. Regression: the old snake_case content-block matcher
// never matched the engine's event shapes, so delegation logs carried no
// per-tool lines at all.

const { consumeEventLine } = await import("../extensions/roster/index.ts");

function harness() {
	const lines = [];
	const result = {
		exitCode: 0,
		finalText: "",
		stderr: "",
		sessionId: null,
		usage: { input: 0, output: 0, turns: 0 },
		seenToolCalls: new Set(),
		seenToolResults: new Set(),
	};
	const consume = (record) => consumeEventLine(record, result, (line) => lines.push(line));
	return { lines, result, consume };
}

test("tool_execution events emit one call and one result line", () => {
	const h = harness();
	h.consume({
		type: "tool_execution_start",
		toolCallId: "c1",
		toolName: "read",
		args: { path: "/tmp/x" },
	});
	h.consume({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false });
	assert.deepEqual(h.lines, ["→ read path=/tmp/x", "← result"]);
});

test("message_end camelCase blocks emit lines (JSON-mode path)", () => {
	const h = harness();
	h.consume({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking" },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls -la" } },
			],
		},
	});
	h.consume({
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "c2",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "boom" }],
		},
	});
	assert.deepEqual(h.lines, ["→ bash command=ls -la", "← result (error)"]);
});

test("dual reporting dedupes per toolCallId in both directions", () => {
	const h = harness();
	h.consume({
		type: "tool_execution_start",
		toolCallId: "c3",
		toolName: "read",
		args: { path: "/a" },
	});
	h.consume({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "c3", name: "read", arguments: { path: "/a" } }],
		},
	});
	h.consume({
		type: "message_end",
		message: { role: "toolResult", toolCallId: "c3", isError: false },
	});
	h.consume({ type: "tool_execution_end", toolCallId: "c3", isError: false });
	assert.deepEqual(h.lines, ["→ read path=/a", "← result"]);
});

test("tool args are redacted before hitting the log line", () => {
	const h = harness();
	h.consume({
		type: "tool_execution_start",
		toolCallId: "c4",
		toolName: "bash",
		args: { command: "curl -H 'Authorization: Bearer sk-live-secret123'" },
	});
	assert.ok(h.lines[0]?.startsWith("→ bash command="));
	assert.ok(!h.lines[0]?.includes("sk-live-secret123"), `secret leaked: ${h.lines[0]}`);
});

test("session events still map without action lines", () => {
	const h = harness();
	h.consume({ type: "session", id: "s1" });
	assert.equal(h.result.sessionId, "s1");
	assert.deepEqual(h.lines, []);
});
