import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-compact-fold-"));
process.env["TORUS_HOME"] = home;

const compact = await import("../extensions/compact/index.ts");
const goal = await import("../extensions/goal/index.ts");
const todo = await import("../extensions/todo/index.ts");

const SID = "33333333-3333-7333-8333-333333333333";

function harness(deps, opts = {}) {
	const handlers = {};
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
	};
	compact.registerCompact(fakePi, deps);
	handlers["session_start"](
		{ type: "session_start", reason: "startup" },
		{
			sessionManager: { getSessionId: () => SID },
			getContextUsage: () => opts.usage,
			ui: { setStatus: () => {} },
		},
	);
	return handlers;
}

/** Context fake that records every setStatus call, with a fixed usage snapshot. */
function chipCtx(usage) {
	const calls = [];
	return {
		ctx: {
			sessionManager: { getSessionId: () => SID },
			getContextUsage: () => usage,
			ui: { setStatus: (key, text) => calls.push({ key, text }) },
		},
		calls,
	};
}

function compactEvent(overrides = {}) {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "entry-1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1000,
			fileOps: { readFiles: [], modifiedFiles: [] },
			settings: { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 },
		},
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

test("empty session state: handler is a no-op and returns undefined", async () => {
	const handlers = harness();
	const result = await handlers["session_before_compact"](compactEvent(), {});
	assert.equal(result, undefined, "nothing to fold means no compaction override");
});

test("planted goal and todos fold into the instructions", () => {
	try {
		goal.writeGoal(SID, {
			goal: "ship the folding feature",
			status: "active",
			createdAt: 1,
			notes: ["planted"],
		});
		todo.writeTodos(SID, [
			{ content: "write the fold tests", status: "in_progress", priority: "high" },
		]);

		const plain = compact.buildFoldInstructions({});
		assert.ok(plain.includes("ship the folding feature"), "goal text is folded");
		assert.ok(plain.includes("write the fold tests"), "todo line is folded");
		assert.ok(
			plain.includes("Torus session context to carry through the summary:"),
			"appendix carries its header",
		);

		const merged = compact.buildFoldInstructions({ customInstructions: "Focus on API changes." });
		assert.ok(
			merged.startsWith("Focus on API changes."),
			"existing custom instructions keep first position",
		);
		assert.ok(merged.includes("ship the folding feature"), "appendix follows the prefix");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("injected generate receives the folded instructions and its result wins", async () => {
	try {
		goal.writeGoal(SID, {
			goal: "carry me through",
			status: "active",
			createdAt: 1,
			notes: [],
		});
		const received = [];
		const fake = { summary: "folded", firstKeptEntryId: "entry-1", tokensBefore: 1000 };
		const handlers = harness({
			generate: (event, ctx, instructions) => {
				received.push({ event, ctx, instructions });
				return fake;
			},
		});

		const result = await handlers["session_before_compact"](compactEvent(), { marker: "ctx" });
		assert.deepEqual(result, { compaction: fake }, "handler returns the fake compaction result");
		assert.equal(received.length, 1, "generate is called exactly once");
		assert.ok(
			received[0].instructions.includes("carry me through"),
			"generate sees the folded goal text",
		);
		assert.ok(
			received[0].instructions.includes("Torus session context to carry through the summary:"),
			"generate sees the appendix header",
		);
		assert.equal(received[0].ctx.marker, "ctx", "generate receives the hook context");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("failing generate falls back to undefined instead of rejecting", async () => {
	try {
		goal.writeGoal(SID, {
			goal: "fold then fail",
			status: "active",
			createdAt: 1,
			notes: [],
		});
		const handlers = harness({
			generate: () => {
				throw new Error("summary backend down");
			},
		});
		const result = await handlers["session_before_compact"](compactEvent(), {});
		assert.equal(result, undefined, "generation failure means no override, no rejection");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aborted signal skips generation even with state to fold", async () => {
	try {
		goal.writeGoal(SID, {
			goal: "abort before me",
			status: "active",
			createdAt: 1,
			notes: [],
		});
		let calls = 0;
		const handlers = harness({
			generate: () => {
				calls += 1;
				return { summary: "unused", firstKeptEntryId: "entry-1", tokensBefore: 1000 };
			},
		});
		const controller = new AbortController();
		controller.abort();
		const result = await handlers["session_before_compact"](
			compactEvent({ signal: controller.signal }),
			{},
		);
		assert.equal(result, undefined, "aborted compaction is left to the engine");
		assert.equal(calls, 0, "generate is never called once aborted");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('context chip paints "ctx 42%" on message_end', () => {
	const handlers = harness();
	const { ctx, calls } = chipCtx({ tokens: 84000, contextWindow: 200000, percent: 42 });
	handlers["message_end"]({ type: "message_end" }, ctx);
	assert.deepEqual(
		calls,
		[{ key: "torus:ctx", text: "ctx 42%" }],
		"exact chip text, no tokens or thresholds",
	);
});

test("context chip repaints on session_start and rounds the percentage", () => {
	const handlers = harness();
	const { ctx, calls } = chipCtx({ tokens: 168800, contextWindow: 200000, percent: 84.4 });
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(
		calls,
		[{ key: "torus:ctx", text: "ctx 84%" }],
		"session_start repaints with Math.round",
	);
});

test("context chip clears when the token estimate is unknown right after compaction", () => {
	const handlers = harness();
	const { ctx, calls } = chipCtx({ tokens: null, contextWindow: 200000, percent: null });
	handlers["message_end"]({ type: "message_end" }, ctx);
	assert.deepEqual(
		calls,
		[{ key: "torus:ctx", text: undefined }],
		"null percent clears the segment",
	);
});

test("context chip clears when getContextUsage returns undefined", () => {
	const handlers = harness();
	const { ctx, calls } = chipCtx(undefined);
	handlers["message_end"]({ type: "message_end" }, ctx);
	assert.deepEqual(
		calls,
		[{ key: "torus:ctx", text: undefined }],
		"no usage at all clears the segment",
	);
});

test("session_compact repaints so the chip clears immediately after compaction", () => {
	const handlers = harness();
	const { ctx, calls } = chipCtx({ tokens: null, contextWindow: 200000, percent: null });
	handlers["session_compact"](
		{ type: "session_compact", reason: "manual", fromExtension: false, willRetry: false },
		ctx,
	);
	assert.deepEqual(
		calls,
		[{ key: "torus:ctx", text: undefined }],
		"compaction resets the chip right away",
	);
});
