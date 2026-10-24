import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// The fast chain resolves through modelChain("fast"), which reads
// chains.json under TORUS_HOME on every call — point it at an empty sandbox
// so the built-in chain is what tests see.
process.env.TORUS_HOME = mkdtempSync(path.join(tmpdir(), "torus-automode-classify-"));

const {
	pickModel,
	pickChatModel,
	CHOICE_RUBRIC,
	judgeGuidanceText,
	classifyWithClassifier,
	classifyWithChat,
	decide,
	DecisionCache,
} = await import("../extensions/automode/classify.ts");

const classifierModel = (id = "perm-1", provider = "typesafe") => ({
	type: "classifier",
	id,
	provider,
	name: id,
	api: "typesafe-system-one",
	baseUrl: "https://classifier.example",
	input: [],
	cost: { input: 0, output: 0 },
	contextWindow: 100_000,
});

const chatModel = (id = "chat-1", provider = "prov") => ({
	id,
	provider,
	name: id,
	api: "anthropic-messages",
	baseUrl: "https://chat.example",
	input: [],
	cost: { input: 0, output: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
	reasoning: false,
});

const choiceAnswer = (choice, confidence = 0.9) => ({
	type: "choice",
	choice,
	confidence,
	probabilities: { [choice]: confidence },
});

const classifierResult = (answer, over = {}) => ({
	api: "typesafe-system-one",
	provider: "typesafe",
	model: "perm-1",
	answers: answer === undefined ? {} : { verdict: answer },
	stopReason: "stop",
	timestamp: 0,
	...over,
});

const assistantText = (text, over = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "prov",
	model: "chat-1",
	usage: {
		totalTokens: 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
	...over,
});

const registryStub = ({
	available = [],
	classifyImpl,
	completeImpl,
	findImpl,
	authImpl = () => true,
} = {}) => ({
	async getAvailableOfType(type) {
		assert.equal(type, "classifier");
		return available;
	},
	getModelOfType(type, provider, modelId) {
		assert.equal(type, "classifier");
		return available.find((m) => m.provider === provider && m.id === modelId);
	},
	find(provider, modelId) {
		return findImpl?.(provider, modelId);
	},
	hasConfiguredAuth(model) {
		return authImpl(model);
	},
	async classify(model, context, options) {
		return classifyImpl(model, context, options);
	},
	async complete(model, context, options) {
		return completeImpl(model, context, options);
	},
});

test("pickModel: a pin that resolves returns exactly that classifier", async () => {
	const cm = classifierModel();
	const registry = registryStub({ available: [classifierModel("other-1"), cm] });
	const picked = await pickModel(registry, { provider: "typesafe", modelId: "perm-1" });
	assert.equal(picked.model, cm);
	assert.equal(picked.warning, undefined);
});

test("pickModel: an unknown pin returns no model and a warning naming it", async () => {
	const registry = registryStub({ available: [classifierModel()] });
	const picked = await pickModel(registry, { provider: "typesafe", modelId: "nope" });
	assert.equal(picked.model, undefined);
	assert.ok(picked.warning?.includes("typesafe/nope"), `warning names the pin: ${picked.warning}`);
});

test("pickModel: without a pin the first available classifier wins", async () => {
	const first = classifierModel("first");
	const registry = registryStub({ available: [first, classifierModel("second")] });
	const picked = await pickModel(registry);
	assert.equal(picked.model, first);
	assert.equal(picked.warning, undefined);
});

test("pickModel: nothing available yields neither model nor warning", async () => {
	const picked = await pickModel(registryStub());
	assert.equal(picked.model, undefined);
	assert.equal(picked.warning, undefined);
});

test("classifyWithClassifier: choice answer maps to a model Decision with rubric reason", async () => {
	const cm = classifierModel();
	let seen;
	const registry = registryStub({
		classifyImpl: (model, context, options) => {
			seen = { model, context, options };
			return classifierResult(choiceAnswer("allow", 0.9));
		},
	});
	const outcome = await classifyWithClassifier(registry, cm, "npm test", "/repo/wt");
	assert.deepEqual(outcome, {
		verdict: "allow",
		source: "model",
		model: "typesafe/perm-1",
		confidence: 0.9,
		reason: `allow: ${CHOICE_RUBRIC.allow}`,
	});
	assert.equal(seen.model, cm);
	assert.deepEqual(seen.context.state, { command: "npm test", cwd: "/repo/wt" });
	const question = seen.context.questions.verdict;
	assert.equal(question.type, "choice");
	assert.deepEqual(question.criteria, CHOICE_RUBRIC);
	assert.equal(seen.options, undefined);
});

test("classifyWithClassifier: an explicit signal reaches the classify options", async () => {
	const cm = classifierModel();
	const controller = new AbortController();
	let seenSignal;
	const registry = registryStub({
		classifyImpl: (_model, _context, options) => {
			seenSignal = options?.signal;
			return classifierResult(choiceAnswer("deny", 0.99));
		},
	});
	const outcome = await classifyWithClassifier(
		registry,
		cm,
		"sudo rm -rf /",
		"/repo",
		controller.signal,
	);
	assert.equal(seenSignal, controller.signal);
	assert.equal(outcome.verdict, "deny");
});

test("classifyWithClassifier: a non-stop result is an error carrying the message", async () => {
	const registry = registryStub({
		classifyImpl: () => classifierResult(undefined, { stopReason: "error", errorMessage: "boom" }),
	});
	const outcome = await classifyWithClassifier(registry, classifierModel(), "ls", "/repo");
	assert.ok("error" in outcome);
	assert.match(outcome.error, /boom/);
	assert.match(outcome.error, /perm-1/);
});

test("classifyWithClassifier: missing, non-choice, and unknown answers are errors", async () => {
	const cases = [
		[classifierResult(undefined), /no choice answer/],
		[classifierResult({ type: "score", score: 1, confidence: 0.9 }), /no choice answer/],
		[classifierResult(choiceAnswer("maybe")), /unknown verdict "maybe"/],
	];
	for (const [result, pattern] of cases) {
		const registry = registryStub({ classifyImpl: () => result });
		const outcome = await classifyWithClassifier(registry, classifierModel(), "ls", "/repo");
		assert.ok("error" in outcome, `result ${JSON.stringify(result)} is an error`);
		assert.match(outcome.error, pattern);
	}
});

test("classifyWithClassifier: a thrown registry error is returned as an error, not propagated", async () => {
	const registry = registryStub({
		classifyImpl: () => {
			throw new Error("engine exploded");
		},
	});
	const outcome = await classifyWithClassifier(registry, classifierModel(), "ls", "/repo");
	assert.ok("error" in outcome);
	assert.match(outcome.error, /engine exploded/);
});

test("classifyWithClassifier: low confidence demotes the verdict to ask", async () => {
	const registry = registryStub({
		classifyImpl: () => classifierResult(choiceAnswer("allow", 0.5)),
	});
	const outcome = await classifyWithClassifier(registry, classifierModel(), "npm test", "/repo");
	assert.deepEqual(outcome, {
		verdict: "ask",
		source: "model",
		model: "typesafe/perm-1",
		confidence: 0.5,
		reason: `classifier chose allow below the confidence threshold; asking (allow: ${CHOICE_RUBRIC.allow})`,
	});
});

const captureChat = (impl) => {
	const calls = [];
	const registry = registryStub({
		completeImpl: (model, context, options) => {
			calls.push({ model, context, options });
			return impl(model, context, options);
		},
	});
	return { registry, calls };
};

test("classifyWithChat: strict JSON reply maps to a model Decision and the prompt carries the rubric", async () => {
	const { registry, calls } = captureChat(() =>
		assistantText('{"verdict":"allow","confidence":0.8,"reason":"local test run"}'),
	);
	const outcome = await classifyWithChat(registry, chatModel(), "npm test", "/repo/wt");
	assert.deepEqual(outcome, {
		verdict: "allow",
		source: "model",
		model: "prov/chat-1",
		confidence: 0.8,
		reason: "local test run",
	});
	const call = calls[0];
	assert.equal(call.model.id, "chat-1");
	assert.ok(call.context.systemPrompt?.includes(CHOICE_RUBRIC.allow));
	assert.ok(call.context.systemPrompt?.includes(CHOICE_RUBRIC.ask));
	assert.ok(call.context.systemPrompt?.includes(CHOICE_RUBRIC.deny));
	assert.ok(call.context.systemPrompt?.includes("data"));
	assert.ok(call.context.systemPrompt?.includes('"verdict":"allow|ask|deny"'));
	assert.deepEqual(call.context.messages, [
		{
			role: "user",
			content: [{ type: "text", text: '{"command":"npm test","cwd":"/repo/wt"}' }],
			timestamp: call.context.messages[0].timestamp,
		},
	]);
});

test("classifyWithChat: JSON wrapped in prose still parses (first object wins)", async () => {
	const { registry } = captureChat(() =>
		assistantText('Sure!\n{"verdict":"ask","confidence":0.9,"reason":"pushes to a remote"}\nDone.'),
	);
	const outcome = await classifyWithChat(registry, chatModel(), "git push", "/repo");
	assert.ok(!("error" in outcome));
	assert.equal(outcome.verdict, "ask");
	assert.equal(outcome.confidence, 0.9);
});

test("classifyWithChat: braces inside the reason string do not truncate the object", async () => {
	const { registry } = captureChat(() =>
		assistantText('{"verdict":"allow","confidence":0.7,"reason":"echo {config} locally"}'),
	);
	const outcome = await classifyWithChat(registry, chatModel(), "echo {config}", "/repo");
	assert.ok(!("error" in outcome));
	assert.equal(outcome.reason, "echo {config} locally");
});

test("classifyWithChat: junk, truncated JSON, and bad verdicts are errors", async () => {
	const badReplies = [
		["I think that is fine", /no parseable JSON object/],
		['{"verdict":"ask","confidence":0.9', /no parseable JSON object/],
		['{"verdict":"maybe","confidence":0.9,"reason":"x"}', /returned verdict "maybe"/],
		['["allow"]', /no parseable JSON object/],
	];
	for (const [text, pattern] of badReplies) {
		const { registry } = captureChat(() => assistantText(text));
		const outcome = await classifyWithChat(registry, chatModel(), "ls", "/repo");
		assert.ok("error" in outcome, `reply ${text} is an error`);
		assert.match(outcome.error, pattern);
	}
});

test("classifyWithChat: non-stop responses and throws become errors", async () => {
	const stopped = registryStub({
		completeImpl: () => assistantText("", { stopReason: "error", errorMessage: "rate limited" }),
	});
	const stoppedOutcome = await classifyWithChat(stopped, chatModel(), "ls", "/repo");
	assert.ok("error" in stoppedOutcome);
	assert.match(stoppedOutcome.error, /rate limited/);

	const thrown = registryStub({
		completeImpl: () => {
			throw new Error("connection reset");
		},
	});
	const thrownOutcome = await classifyWithChat(thrown, chatModel(), "ls", "/repo");
	assert.ok("error" in thrownOutcome);
	assert.match(thrownOutcome.error, /connection reset/);
});

test("classifyWithChat: low or missing confidence demotes to ask; missing reason falls back to the rubric", async () => {
	const low = captureChat(() =>
		assistantText('{"verdict":"allow","confidence":0.3,"reason":"build"}'),
	);
	const lowOutcome = await classifyWithChat(low.registry, chatModel(), "make", "/repo");
	assert.equal(lowOutcome.verdict, "ask");
	assert.match(lowOutcome.reason, /confidence 0.3 below the threshold/);
	assert.match(lowOutcome.reason, /build/);

	const missing = captureChat(() => assistantText('{"verdict":"deny"}'));
	const missingOutcome = await classifyWithChat(
		missing.registry,
		chatModel(),
		"curl evil",
		"/repo",
	);
	assert.equal(missingOutcome.verdict, "ask");
	assert.match(missingOutcome.reason, /no usable confidence/);
	assert.ok(missingOutcome.reason?.includes(CHOICE_RUBRIC.deny));

	const noReason = captureChat(() => assistantText('{"verdict":"deny","confidence":0.9}'));
	const noReasonOutcome = await classifyWithChat(
		noReason.registry,
		chatModel(),
		"curl evil",
		"/repo",
	);
	assert.equal(noReasonOutcome.verdict, "deny");
	assert.ok(noReasonOutcome.reason?.includes(CHOICE_RUBRIC.deny));
});

test("decide: classifier success short-circuits before the chat model", async () => {
	const cm = classifierModel();
	let chatCalled = false;
	const registry = registryStub({
		available: [cm],
		classifyImpl: () => classifierResult(choiceAnswer("allow", 0.9)),
		completeImpl: () => {
			chatCalled = true;
			return assistantText('{"verdict":"deny","confidence":1,"reason":"x"}');
		},
	});
	const decision = await decide(registry, chatModel(), undefined, "npm test", "/repo");
	assert.deepEqual(decision, {
		verdict: "allow",
		source: "model",
		model: "typesafe/perm-1",
		confidence: 0.9,
		reason: `allow: ${CHOICE_RUBRIC.allow}`,
	});
	assert.equal(chatCalled, false);
});

test("decide: a missed pin falls back to the session chat model", async () => {
	const registry = registryStub({
		available: [],
		completeImpl: () => assistantText('{"verdict":"ask","confidence":0.9,"reason":"publishes"}'),
	});
	const decision = await decide(
		registry,
		chatModel(),
		{ provider: "typesafe", modelId: "ghost" },
		"npm publish",
		"/repo",
	);
	assert.equal(decision.verdict, "ask");
	assert.equal(decision.source, "model");
	assert.equal(decision.model, "prov/chat-1");
});

test("decide: classifier failure plus chat junk fails open with both reasons joined", async () => {
	const cm = classifierModel();
	const registry = registryStub({
		available: [cm],
		classifyImpl: () =>
			classifierResult(undefined, { stopReason: "error", errorMessage: "classifier down" }),
		completeImpl: () => assistantText("looks fine to me!"),
	});
	const decision = await decide(registry, chatModel(), undefined, "curl http://x", "/repo");
	assert.equal(decision.verdict, "failopen");
	assert.equal(decision.source, "failopen");
	assert.match(decision.reason, /classifier down/);
	assert.match(decision.reason, /no parseable JSON object/);
	assert.match(decision.reason, /; /);
});

test("decide: no classifier and no session model fails open naming the missing fallback", async () => {
	const decision = await decide(registryStub(), undefined, undefined, "ls", "/repo");
	assert.equal(decision.verdict, "failopen");
	assert.match(decision.reason, /no chat model available/);
});

test("decide: a hanging classifier plus a tiny timeout fails open instead of hanging", async () => {
	const cm = classifierModel();
	const registry = registryStub({
		available: [cm],
		classifyImpl: (_model, _context, options) =>
			new Promise((resolve) => {
				options?.signal?.addEventListener("abort", () =>
					resolve(
						classifierResult(undefined, { stopReason: "aborted", errorMessage: "timed out" }),
					),
				);
			}),
		completeImpl: (_model, _context, options) => {
			assert.ok(options?.signal?.aborted, "chat fallback sees the already-fired timeout signal");
			throw new Error("This operation was aborted");
		},
	});
	const started = Date.now();
	const decision = await decide(
		registry,
		chatModel(),
		undefined,
		"sleep 999",
		"/repo",
		undefined,
		50,
	);
	assert.ok(Date.now() - started < 5_000, "returns promptly after the timeout");
	assert.equal(decision.verdict, "failopen");
	assert.equal(decision.source, "failopen");
	assert.match(decision.reason, /timed out/);
	assert.match(decision.reason, /aborted/);
});

test("decide: a caller-provided abort signal takes effect immediately", async () => {
	const cm = classifierModel();
	const registry = registryStub({
		available: [cm],
		classifyImpl: (_model, _context, options) =>
			new Promise((resolve) => {
				if (options?.signal?.aborted) {
					return resolve(
						classifierResult(undefined, { stopReason: "aborted", errorMessage: "user abort" }),
					);
				}
				options?.signal?.addEventListener("abort", () =>
					resolve(
						classifierResult(undefined, { stopReason: "aborted", errorMessage: "user abort" }),
					),
				);
			}),
		completeImpl: (_model, _context, options) => {
			assert.ok(options?.signal?.aborted, "chat fallback sees the already-aborted signal");
			throw new Error("This operation was aborted");
		},
	});
	const controller = new AbortController();
	controller.abort();
	const decision = await decide(
		registry,
		chatModel(),
		undefined,
		"npm test",
		"/repo",
		controller.signal,
		60_000,
	);
	assert.equal(decision.verdict, "failopen");
	assert.match(decision.reason, /user abort/);
});

const d = (verdict, over = {}) => ({ verdict, source: "model", reason: "test", ...over });

test("DecisionCache: keys are normalized commands", () => {
	const cache = new DecisionCache();
	cache.set("git    status", d("allow"));
	assert.equal(cache.get("git status")?.verdict, "allow");
	assert.equal(cache.get("  git\tstatus  ")?.verdict, "allow");
	assert.equal(cache.get("git log"), undefined);
});

test("DecisionCache: FIFO eviction at the cap evicts the oldest inserted", () => {
	const cache = new DecisionCache(2);
	cache.set("a", d("allow"));
	cache.set("b", d("ask"));
	assert.equal(cache.size, 2);
	cache.set("c", d("deny"));
	assert.equal(cache.size, 2);
	assert.equal(cache.get("a"), undefined, "oldest inserted evicted");
	assert.equal(cache.get("b")?.verdict, "ask");
	assert.equal(cache.get("c")?.verdict, "deny");
});

test("DecisionCache: re-setting an existing key updates the value without refreshing its slot", () => {
	const cache = new DecisionCache(2);
	cache.set("a", d("allow"));
	cache.set("b", d("ask"));
	cache.set("a", d("deny"));
	assert.equal(cache.get("a")?.verdict, "deny", "value updated");
	cache.set("c", d("allow"));
	assert.equal(cache.size, 2);
	assert.equal(cache.get("a"), undefined, "original insertion slot still evicted first");
	assert.equal(cache.get("c")?.verdict, "allow");
});

test("DecisionCache: default capacity is 500 and clear empties the map", () => {
	const cache = new DecisionCache();
	for (let i = 0; i < 501; i++) {
		cache.set(`cmd-${i}`, d("allow"));
	}
	assert.equal(cache.size, 500);
	assert.equal(cache.get("cmd-0"), undefined, "first inserted evicted at the cap");
	assert.equal(cache.get("cmd-500")?.verdict, "allow");
	cache.clear();
	assert.equal(cache.size, 0);
	assert.equal(cache.get("cmd-500"), undefined);
});

test("pickChatModel: the first known fast-chain model with credentials wins", () => {
	const flash = chatModel("glm-5.3-flash", "zai");
	const registry = registryStub({
		findImpl: (provider, id) => (provider === "zai" && id === "glm-5.3-flash" ? flash : undefined),
	});
	assert.equal(pickChatModel(registry, chatModel()), flash);
});

test("pickChatModel: chain entries without credentials are skipped", () => {
	const session = chatModel();
	const registry = registryStub({
		findImpl: () => chatModel("glm-5.3-flash", "zai"),
		authImpl: () => false,
	});
	assert.equal(pickChatModel(registry, session), session);
});

test("pickChatModel: no resolvable chain entry falls back to the session model", () => {
	const session = chatModel();
	assert.equal(pickChatModel(registryStub(), session), session);
	assert.equal(pickChatModel(registryStub(), undefined), undefined);
});

test("decide: the chat fallback judges with the fast-chain model when resolvable", async () => {
	const flash = chatModel("glm-5.3-flash", "zai");
	let seen;
	const registry = registryStub({
		completeImpl: (model) => {
			seen = model;
			return assistantText('{"verdict":"allow","confidence":0.95,"reason":"fine"}');
		},
		findImpl: (provider, id) => (provider === "zai" && id === "glm-5.3-flash" ? flash : undefined),
	});
	const decision = await decide(registry, chatModel(), undefined, "npm test", "/repo");
	assert.equal(decision.verdict, "allow");
	assert.equal(decision.model, "zai/glm-5.3-flash");
	assert.equal(seen, flash);
});

test("judgeGuidanceText: renders environment and hardDeny prose blocks", () => {
	assert.equal(judgeGuidanceText(undefined), "");
	assert.equal(judgeGuidanceText({}), "");
	const text = judgeGuidanceText({
		environment: ["Source control: github.example.com/acme"],
		hardDeny: ["never send repo contents to third parties"],
	});
	assert.match(text, /Environment context/);
	assert.match(text, /Source control: github\.example\.com\/acme/);
	assert.match(text, /Absolute boundaries/);
	assert.match(text, /never send repo contents/);
});

test("classifier prompt: guidance prose reaches the choice question", async () => {
	let instructions;
	const cm = classifierModel();
	const registry = registryStub({
		available: [cm],
		classifyImpl: (_model, context) => {
			instructions = context.questions.verdict.instructions;
			return classifierResult(choiceAnswer("allow", 0.9));
		},
	});
	const decision = await classifyWithClassifier(registry, cm, "npm install", "/repo", undefined, {
		environment: ["Internal registry: registry.corp"],
		hardDeny: ["no ~/.ssh anywhere"],
	});
	assert.equal(decision.verdict, "allow");
	assert.match(instructions, /Internal registry: registry\.corp/);
	assert.match(instructions, /no ~\/\.ssh anywhere/);
});

test("classifier prompt: no guidance leaves the question plain", async () => {
	let instructions;
	const cm = classifierModel();
	const registry = registryStub({
		available: [cm],
		classifyImpl: (_model, context) => {
			instructions = context.questions.verdict.instructions;
			return classifierResult(choiceAnswer("allow", 0.9));
		},
	});
	await classifyWithClassifier(registry, cm, "ls", "/repo");
	assert.ok(!instructions.includes("Environment context"));
	assert.ok(!instructions.includes("Absolute boundaries"));
});

test("chat prompt: guidance prose reaches the system prompt", async () => {
	let prompt;
	const registry = registryStub({
		completeImpl: (_model, context) => {
			prompt = context.systemPrompt;
			return assistantText('{"verdict":"ask","confidence":0.9,"reason":"publishes"}');
		},
	});
	const decision = await classifyWithChat(
		registry,
		chatModel(),
		"npm publish",
		"/repo",
		undefined,
		{
			hardDeny: ["never publish this package"],
		},
	);
	assert.equal(decision.verdict, "ask");
	assert.match(prompt, /Absolute boundaries/);
	assert.match(prompt, /never publish this package/);
});
