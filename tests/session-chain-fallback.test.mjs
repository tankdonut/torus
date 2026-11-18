import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The main-session chain walker: when a run settles on an engine-signaled
// model-error turn, the session moves to the next credentialed chain
// candidate via pi.setModel, omits the failed attempt from model context
// (context_edit targeting the errored assistant entry), and requests one
// boundary continuation so pi re-runs the turn. The failed model joins the
// session no-work cooldown children skip too. A model outside both chains,
// a chain-exhausted position, a context overflow, and a credential-less
// target all leave the error untouched.
const home = mkdtempSync(path.join(tmpdir(), "torus-chain-walker-"));
process.env["TORUS_HOME"] = home;
process.env["ZAI_API_KEY"] = "torus-test-dummy";
process.env["OPENCODE_API_KEY"] = "torus-test-dummy";

const providers = await import("../extensions/providers/index.ts");

const DEFAULT_PRIMARY = ["zai/glm-5.3", "zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"];

function erroredAssistant(overrides = {}) {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "zai",
		model: "glm-5.3",
		usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		stopReason: "error",
		errorMessage: '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted."}',
		timestamp: Date.now(),
		...overrides,
	};
}

function harness(model = { provider: "zai", id: "glm-5.3", contextWindow: 128000 }) {
	const handlers = {};
	const setModelCalls = [];
	const notifies = [];
	const models = {
		"zai/glm-5.3-flash": { provider: "zai", id: "glm-5.3-flash", contextWindow: 128000 },
		"opencode-go/glm-5.3-flash": {
			provider: "opencode-go",
			id: "glm-5.3-flash",
			contextWindow: 128000,
		},
	};
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		setModel: (model) => {
			setModelCalls.push(`${model.provider}/${model.id}`);
			return true;
		},
	};
	const ctx = {
		hasUI: true,
		model,
		ui: { notify: (message, type) => notifies.push({ message, type }) },
		modelRegistry: { find: (provider, id) => models[`${provider}/${id}`] },
	};
	providers.registerChainWalker(fakePi);
	return { handlers, setModelCalls, notifies, ctx, models };
}

function turnEndEvent(message, entryId = "entry-errored") {
	return {
		type: "turn_end",
		turnIndex: 0,
		message,
		toolResults: [],
		messageEntryId: entryId,
		toolResultEntryIds: [],
		entries: [],
		continue: false,
		context: {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: true,
		},
		outcome: message.stopReason === "error" ? "error" : "completed",
	};
}

function settleEvent() {
	return {
		type: "agent_before_settle",
		entries: [],
		continue: false,
		context: {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: true,
		},
		outcome: "error",
	};
}

after(() => {
	providers.resetFailureMemoForTesting();
	providers.resetChainWalkerForTesting();
	delete process.env["ZAI_API_KEY"];
	delete process.env["OPENCODE_API_KEY"];
	rmSync(home, { recursive: true, force: true });
});

/** Run body with the no-work memo cleared afterwards, even on assertion failure. */
async function withFreshMemo(body) {
	try {
		await body();
	} finally {
		providers.resetFailureMemoForTesting();
	}
}

test("quota-exhausted head falls back to the next chain model and re-runs the turn", () =>
	withFreshMemo(async () => {
		const { handlers, setModelCalls, notifies, ctx } = harness();
		handlers["turn_end"](turnEndEvent(erroredAssistant()), ctx);
		const result = await handlers["agent_before_settle"](settleEvent(), ctx);
		assert.deepEqual(setModelCalls, ["zai/glm-5.3-flash"], "walks to the next primary candidate");
		assert.deepEqual(result, {
			entries: [{ type: "context_edit", targetId: "entry-errored", replacement: null }],
			continue: true,
		});
		assert.deepEqual(
			notifies.map((n) => n.type),
			["warning"],
			"the fallback surfaces as a warning",
		);
		assert.ok(
			notifies[0].message.includes("zai/glm-5.3") &&
				notifies[0].message.includes("zai/glm-5.3-flash"),
		);
	}));

test("failed model joins the no-work cooldown children skip", () =>
	withFreshMemo(async () => {
		const { handlers, ctx } = harness();
		handlers["turn_end"](turnEndEvent(erroredAssistant()), ctx);
		await handlers["agent_before_settle"](settleEvent(), ctx);
		assert.equal(providers.isModelMemoFailed("zai/glm-5.3"), true);
	}));

test("a completed turn clears the pending failure: settle is a no-op", async () => {
	const { handlers, setModelCalls, ctx } = harness();
	handlers["turn_end"](turnEndEvent(erroredAssistant()), ctx);
	handlers["turn_end"](
		turnEndEvent(erroredAssistant({ stopReason: "stop", errorMessage: undefined })),
		ctx,
	);
	const result = await handlers["agent_before_settle"](settleEvent(), ctx);
	assert.equal(result, undefined);
	assert.deepEqual(setModelCalls, []);
});

test("chain-exhausted position leaves the error alone", async () => {
	const last = DEFAULT_PRIMARY[DEFAULT_PRIMARY.length - 1];
	const [lastProvider, lastId] = last.split("/");
	const { handlers, setModelCalls, ctx } = harness({
		provider: lastProvider,
		id: lastId,
		contextWindow: 128000,
	});
	handlers["turn_end"](
		turnEndEvent(erroredAssistant({ provider: lastProvider, model: lastId })),
		ctx,
	);
	try {
		const result = await handlers["agent_before_settle"](settleEvent(), ctx);
		assert.equal(result, undefined);
		assert.deepEqual(setModelCalls, []);
	} finally {
		providers.resetFailureMemoForTesting();
	}
});

test("a model outside both chains is never hijacked", async () => {
	const { handlers, setModelCalls, ctx } = harness({
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		contextWindow: 128000,
	});
	handlers["turn_end"](
		turnEndEvent(erroredAssistant({ provider: "anthropic", model: "claude-sonnet-4-5" })),
		ctx,
	);
	const result = await handlers["agent_before_settle"](settleEvent(), ctx);
	assert.equal(result, undefined);
	assert.deepEqual(setModelCalls, []);
});

test("a credential-less target leaves the error visible", async () => {
	const { handlers, setModelCalls, notifies, ctx } = harness();
	const withoutKeys = { ...ctx, modelRegistry: { find: () => undefined } };
	handlers["turn_end"](turnEndEvent(erroredAssistant()), withoutKeys);
	const result = await handlers["agent_before_settle"](settleEvent(), withoutKeys);
	assert.equal(result, undefined);
	assert.deepEqual(setModelCalls, []);
	assert.deepEqual(notifies, []);
});

test("context-overflow failures are compaction's job, not the chain's", async () => {
	const { handlers, setModelCalls, ctx } = harness();
	handlers["turn_end"](
		turnEndEvent(
			erroredAssistant({
				errorMessage:
					"Request failed: prompt is too long: 300000 tokens > 128000 token context window",
			}),
		),
		ctx,
	);
	const result = await handlers["agent_before_settle"](settleEvent(), ctx);
	assert.equal(result, undefined);
	assert.deepEqual(setModelCalls, []);
});

test("an unregistered chain id (find misses) leaves the error alone", async () => {
	const { handlers, setModelCalls, ctx } = harness();
	handlers["turn_end"](turnEndEvent(erroredAssistant()), ctx);
	const blindCtx = { ...ctx, modelRegistry: { find: () => undefined } };
	const result = await handlers["agent_before_settle"](settleEvent(), blindCtx);
	assert.equal(result, undefined);
	assert.deepEqual(setModelCalls, []);
});

test("setModel refusing (no auth) leaves the error alone without touching the memo", async () => {
	try {
		const { setModelCalls, ctx } = harness();
		const handlers2 = {};
		providers.registerChainWalker({
			on: (event, handler) => {
				handlers2[event] = handler;
			},
			setModel: () => false,
		});
		handlers2["turn_end"](turnEndEvent(erroredAssistant()), ctx);
		const result = await handlers2["agent_before_settle"](settleEvent(), ctx);
		assert.equal(result, undefined);
		assert.deepEqual(setModelCalls, []);
		assert.equal(providers.isModelMemoFailed("zai/glm-5.3"), false);
	} finally {
		providers.resetFailureMemoForTesting();
	}
});
