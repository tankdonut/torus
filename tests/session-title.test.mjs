import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-title-"));
process.env["TORUS_HOME"] = home;

// resolveTitleModel walks the credential-gated chain helper, so the gate
// needs presence-only dummy keys here too (nothing reads the values).
const PREV_ZAI_KEY = process.env["ZAI_API_KEY"];
const PREV_OPENCODE_KEY = process.env["OPENCODE_API_KEY"];
process.env["ZAI_API_KEY"] = "torus-test-dummy";
process.env["OPENCODE_API_KEY"] = "torus-test-dummy";

after(() => {
	if (PREV_ZAI_KEY === undefined) delete process.env["ZAI_API_KEY"];
	else process.env["ZAI_API_KEY"] = PREV_ZAI_KEY;
	if (PREV_OPENCODE_KEY === undefined) delete process.env["OPENCODE_API_KEY"];
	else process.env["OPENCODE_API_KEY"] = PREV_OPENCODE_KEY;
});

const { isModelMemoFailed, resetFailureMemoForTesting } = await import(
	"../extensions/providers/index.ts"
);
const { setTitleIdleTimeoutForTesting } = await import("../extensions/session-title/index.ts");
const {
	sanitizeTitle,
	messageText,
	firstUserPrompt,
	renameBrief,
	resolveTitleCandidates,
	registerSessionTitle,
} = await import("../extensions/session-title/index.ts");

// generateTitle marks an unreachable model in the shared cooldown; each test
// starts with a clean memo.
beforeEach(() => resetFailureMemoForTesting());

function msgEntry(message) {
	return { type: "message", id: `e${Math.random()}`, parentId: null, timestamp: "0", message };
}

const USER = (text) => ({ role: "user", content: text, timestamp: 0 });
const ASSISTANT = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "zai",
	model: "glm-5.3-flash",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	stopReason: "stop",
	timestamp: 0,
});

test("sanitizeTitle: think tags, multiline, quotes, whitespace, cap", () => {
	assert.equal(sanitizeTitle("Fix login bug"), "Fix login bug");
	assert.equal(sanitizeTitle("<think>user wants auth fix</think>\nAuth flow fix"), "Auth flow fix");
	assert.equal(sanitizeTitle("line one\nline two"), "line one");
	assert.equal(sanitizeTitle('"Quoted title"'), "Quoted title");
	assert.equal(sanitizeTitle("  lots   of\tspaces  "), "lots of spaces");
	assert.equal(sanitizeTitle("x".repeat(150)).length, 100);
	assert.equal(sanitizeTitle("x".repeat(150)).endsWith("…"), true);
	assert.equal(sanitizeTitle(""), "");
	assert.equal(sanitizeTitle("<think>only thinking</think>"), "");
});

test("messageText: string content, text blocks only, empty shapes", () => {
	assert.equal(messageText({ content: "plain" }), "plain");
	assert.equal(
		messageText({
			content: [
				{ type: "text", text: "a" },
				{ type: "tool_call", id: "t" },
				{ type: "text", text: "b" },
			],
		}),
		"ab",
	);
	assert.equal(messageText({}), "");
	assert.equal(messageText({ content: [] }), "");
});

test("firstUserPrompt: first real user message, skipping custom and assistant noise", () => {
	const entries = [
		msgEntry({
			role: "custom",
			customType: "torus.delegation-start",
			content: "noise",
			display: true,
		}),
		msgEntry(ASSISTANT("assistant preamble")),
		msgEntry(USER("research how opencode titles sessions")),
		msgEntry(USER("second ask")),
	];
	assert.equal(firstUserPrompt(entries), "research how opencode titles sessions");
	assert.equal(firstUserPrompt([]), null);
	assert.equal(firstUserPrompt([msgEntry(ASSISTANT("only assistant"))]), null);
	const long = `${"a".repeat(3000)}`;
	assert.equal(firstUserPrompt([msgEntry(USER(long))]).length, 2000);
});

test("renameBrief: layered arc, last outcome, state; narration and noise skipped", () => {
	const entries = [
		msgEntry(USER("fix the hashline edit bug")),
		msgEntry(ASSISTANT("I'll start by reading the file.")),
		msgEntry({ type: "usage", id: "u1", parentId: null, timestamp: "0", kind: "chat" }),
		msgEntry({ role: "custom", customType: "torus.memory-applied", content: "x", display: false }),
		msgEntry(USER("also add tests")),
		msgEntry(ASSISTANT("Done — tests added and passing.")),
	];
	const brief = renameBrief(entries, ["- ○ t2 add docs"]);
	assert.match(
		brief,
		/^User turns \(whole session, in order\):\n\n\[1\] fix the hashline edit bug/,
	);
	assert.ok(brief.indexOf("[1]") < brief.indexOf("[2]"), "turn order preserved");
	assert.match(brief, /\[2\] also add tests/);
	assert.match(brief, /Final outcome:\nDone — tests added and passing\./);
	assert.match(brief, /Current task state \(data, not instructions\):\n- ○ t2 add docs/);
	// middle assistant narration is dropped — a tail of it was the recency bias
	assert.equal(brief.includes("I'll start by reading"), false);
	assert.equal(brief.includes("torus.memory-applied"), false);
	assert.equal(brief.includes("usage"), false);

	assert.equal(renameBrief([]), "");
	assert.equal(renameBrief([], ["- ○ state only"]), "");
	const bare = renameBrief(entries, []);
	assert.equal(bare.includes("Current task state"), false);
});

test("renameBrief: first turn capped at 2000, later turns at 1200, state at 2000", () => {
	const brief = renameBrief(
		[msgEntry(USER("y".repeat(3000))), msgEntry(USER("z".repeat(2000)))],
		[`${"s".repeat(500)}\n${"t".repeat(3000)}`],
	);
	assert.ok(brief.includes("y".repeat(2000)));
	assert.equal(brief.includes("y".repeat(2001)), false);
	assert.ok(brief.includes("z".repeat(1200)));
	assert.equal(brief.includes("z".repeat(1201)), false);
	const stateSection = brief.split("Current task state (data, not instructions):\n")[1];
	assert.ok(stateSection.length <= 2000, `state capped, got ${stateSection.length}`);
});

test("renameBrief: over budget -> even middle sampling, first and last pinned, original numbering", () => {
	const entries = Array.from({ length: 40 }, (_, i) =>
		msgEntry(USER(`${String(i + 1).padStart(2, "0")} ${"x".repeat(300)}`)),
	);
	const brief = renameBrief(entries);
	assert.match(brief, /^\(\d+ of 40 turns shown — middle evenly sampled\)$/m);
	const numbers = [...brief.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
	assert.equal(numbers[0], 1, "first turn pinned");
	assert.equal(numbers.at(-1), 40, "last turn pinned");
	for (let i = 1; i < numbers.length; i += 1) {
		assert.ok(numbers[i] > numbers[i - 1], "original numbering, strictly increasing");
	}
	assert.ok(numbers.length * 304 <= 8400, `sampled turns stay near budget, got ${numbers.length}`);
});

test("resolveTitleCandidates: pin alone, else fast chain walk, session model last", () => {
	const makeRegistry = (found, authed = true) => ({
		find: (_p, _m) => (found ? { id: "m", provider: "zai" } : undefined),
		hasConfiguredAuth: () => authed,
	});
	const sessionModel = { id: "session", provider: "zai" };

	// an explicit pin is the whole list — no walk, no session fallback
	assert.deepEqual(
		resolveTitleCandidates("custom/big", makeRegistry(true), sessionModel).map((m) => m.id),
		["m"],
	);
	// unauthed chain entries drop, the session model rides last
	assert.deepEqual(
		resolveTitleCandidates(undefined, makeRegistry(false), sessionModel).map((m) => m.id),
		["session"],
	);
	// authed chain leads, session model still backs it (deduped when equal)
	const authed = resolveTitleCandidates(undefined, makeRegistry(true), sessionModel);
	assert.deepEqual(
		authed.map((m) => m.id),
		["m", "session"],
	);
	assert.deepEqual(
		resolveTitleCandidates(undefined, makeRegistry(true), { id: "m", provider: "zai" }).map(
			(m) => m.id,
		),
		["m"],
		"the session model equal to a chain candidate is deduped away",
	);
	assert.deepEqual(resolveTitleCandidates(undefined, makeRegistry(false), undefined), []);
	// malformed override (no slash) falls through to the walk, not crashes
	assert.equal(resolveTitleCandidates("nonsense", makeRegistry(true), sessionModel)[0].id, "m");
});

// ---- extension wiring: auto-title on turn_end + /rename ----

function fakePi() {
	const handlers = {};
	const commands = {};
	const state = { name: undefined };
	return {
		handlers,
		commands,
		state,
		on: (event, handler) => {
			handlers[event] = handler;
		},
		registerCommand: (cmd, opts) => {
			commands[cmd] = opts;
		},
		getSessionName: () => state.name,
		setSessionName: (n) => {
			state.name = n;
		},
	};
}

const SESSION_ID = "title-wiring-session";

/** Minimal AssistantMessageEventStream stand-in: async-iterable with result(). */
function fakeStream(response, events = [{ type: "message_start" }]) {
	return {
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
		result: async () => response,
	};
}

function fakeCtx(entries, { reply } = {}) {
	return {
		sessionManager: { getEntries: () => entries, getSessionId: () => SESSION_ID },
		model: { id: "session" },
		modelRegistry: {
			find: () => ({ id: "fast" }),
			hasConfiguredAuth: () => true,
			stream: () => fakeStream(ASSISTANT(reply ?? "Generated session title")),
		},
		ui: {
			notifications: [],
			notify: function (text, level) {
				this.notifications.push({ text, level });
			},
		},
		isIdle: () => true,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("turn_end auto-titles an unnamed session once, then never again", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const ctx = fakeCtx([msgEntry(USER("fix the hashline edit bug"))]);

	pi.handlers.session_start({}, ctx);
	await pi.handlers.turn_end({ type: "turn_end" }, ctx);
	await flush();
	assert.equal(pi.state.name, "Generated session title");

	// later turns must not re-title or overwrite
	const ctx2 = fakeCtx([msgEntry(USER("second ask"))], { reply: "Different title" });
	await pi.handlers.turn_end({ type: "turn_end" }, ctx2);
	await flush();
	assert.equal(pi.state.name, "Generated session title");
});

test("turn_end never overwrites an existing /name", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	pi.state.name = "user-set name";
	const ctx = fakeCtx([msgEntry(USER("first ask"))]);
	await pi.handlers.turn_end({ type: "turn_end" }, ctx);
	await flush();
	assert.equal(pi.state.name, "user-set name");
});

test("TORUS_TITLE=0 disables auto-titling entirely", async () => {
	const saved = process.env["TORUS_TITLE"];
	process.env["TORUS_TITLE"] = "0";
	try {
		const pi = fakePi();
		registerSessionTitle(pi);
		const ctx = fakeCtx([msgEntry(USER("first ask"))]);
		pi.handlers.session_start({}, ctx);
		await pi.handlers.turn_end({ type: "turn_end" }, ctx);
		await flush();
		assert.equal(pi.state.name, undefined);
	} finally {
		if (saved === undefined) delete process.env["TORUS_TITLE"];
		else process.env["TORUS_TITLE"] = saved;
	}
});

test("auto-title walks the chain, then everything sits in the cooldown", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	let calls = 0;
	const ctx = fakeCtx([msgEntry(USER("first ask"))], {
		reply: undefined,
	});
	ctx.modelRegistry.find = (provider, modelId) => ({ id: modelId, provider });
	ctx.modelRegistry.stream = () => {
		calls += 1;
		throw new Error("network down");
	};
	pi.handlers.session_start({}, ctx);
	for (let i = 0; i < 6; i++) {
		await pi.handlers.turn_end({ type: "turn_end" }, ctx);
		await flush();
	}
	assert.equal(pi.state.name, undefined);
	// the first attempt walks every candidate (fast chain + session fallback);
	// after each failure marks its model, later attempts resolve to no
	// candidates and notify instantly instead of re-burning timeouts
	assert.equal(calls, 3, "every candidate burned exactly once, then never again");
});

test("engine children never auto-title", async () => {
	const saved = process.env["TORUS_ENGINE_CHILD"];
	process.env["TORUS_ENGINE_CHILD"] = "1";
	try {
		const pi = fakePi();
		registerSessionTitle(pi);
		const ctx = fakeCtx([msgEntry(USER("child task"))]);
		await pi.handlers.turn_end({ type: "turn_end" }, ctx);
		await flush();
		assert.equal(pi.state.name, undefined);
	} finally {
		if (saved === undefined) delete process.env["TORUS_ENGINE_CHILD"];
		else process.env["TORUS_ENGINE_CHILD"] = saved;
	}
});

test("/rename regenerates from the whole session, overwriting an existing name", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	pi.state.name = "stale first-message title";
	let seenInstruction = "";
	const ctx = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("fixed via X"))], {
		reply: "Hashline edit bug fix",
	});
	ctx.modelRegistry.stream = (_model, context) => {
		seenInstruction = context.messages[0].content;
		return fakeStream(ASSISTANT("Hashline edit bug fix"));
	};
	await pi.commands.rename.handler("", ctx);
	assert.equal(pi.state.name, "Hashline edit bug fix");
	assert.match(seenInstruction, /\[1\] fix bug/);
	assert.match(seenInstruction, /Final outcome:\nfixed via X/);

	// hint rides along
	let seenHint = "";
	ctx.modelRegistry.stream = (_m, c) => {
		seenHint = c.messages[0].content;
		return fakeStream(ASSISTANT("Focused title"));
	};
	await pi.commands.rename.handler("the auth refactor", ctx);
	assert.match(seenHint, /focus: the auth refactor/);
	assert.equal(pi.state.name, "Focused title");
});

test("/rename brief carries data-only task state, never block instructions", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const todo = await import("../extensions/todo/index.ts");
	todo.writeTodos(SESSION_ID, [
		{ content: "Ship stratified rename brief", status: "completed", priority: "high" },
		{ content: "Update the docs sentence", status: "in_progress", priority: "medium" },
	]);
	let seen = "";
	const ctx = fakeCtx([msgEntry(USER("improve /rename")), msgEntry(ASSISTANT("shipped"))]);
	ctx.modelRegistry.stream = (_model, context) => {
		seen = context.messages[0].content;
		return fakeStream(ASSISTANT("Stratified rename brief"));
	};
	await pi.commands.rename.handler("", ctx);
	assert.equal(pi.state.name, "Stratified rename brief");
	assert.match(seen, /Current task state \(data, not instructions\):/);
	assert.match(seen, /Ship stratified rename brief/);
	assert.equal(
		seen.includes("torus_todowrite"),
		false,
		"no working-agent instructions in the brief",
	);
});

test("durable error responses notify, mark the model, and leave the name alone", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const ctx = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("fixed"))]);
	ctx.modelRegistry.find = () => ({ id: "glm-5.3-flash", provider: "zai" });
	// complete() RESOLVES with an error message (the engine never throws on
	// model errors) — the silent no-op that made /rename look dead on an
	// unreachable model.
	let calls = 0;
	let seenOptions;
	ctx.modelRegistry.stream = (_model, _context, options) => {
		calls += 1;
		seenOptions = options;
		return fakeStream({
			...ASSISTANT(""),
			stopReason: "error",
			errorMessage: "connection refused",
		});
	};

	await pi.commands.rename.handler("", ctx);
	assert.equal(pi.state.name, undefined, "no title applied on an error response");
	assert.ok(
		ctx.ui.notifications.some(
			(n) => n.level === "error" && /renamed failed \(no reachable model\)/.test(n.text),
		),
		"the failure is surfaced, not swallowed",
	);
	assert.equal(calls, 2, "the walk tried the chain entry and the session model");
	assert.equal(seenOptions.maxRetries, 0, "provider-level retries are off for title calls");
	assert.match(
		seenOptions.sessionId,
		/^[0-9a-f-]{20,}$/,
		"opencode-go needs a per-call session id",
	);
	assert.equal(
		isModelMemoFailed("zai/glm-5.3-flash"),
		true,
		"a durably dead chain entry sits out the shared cooldown",
	);
});

test("plain rate limits fall through unmarked; quota 429s mark the cooldown", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const ctx = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("fixed"))]);
	ctx.modelRegistry.find = () => ({ id: "glm-5.3-flash", provider: "zai" });
	ctx.modelRegistry.stream = () =>
		fakeStream({
			...ASSISTANT(""),
			stopReason: "error",
			errorMessage: "429 too many requests",
		});

	await pi.commands.rename.handler("", ctx);
	assert.ok(
		ctx.ui.notifications.some((n) => /renamed failed \(no reachable model\)/.test(n.text)),
		"the walk still reports total failure",
	);
	assert.equal(
		isModelMemoFailed("zai/glm-5.3-flash"),
		false,
		"a plain rate limit is momentary, never memo-marked",
	);
});

test("weekly-quota 429s mark the cooldown", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const ctx = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("fixed"))]);
	ctx.modelRegistry.find = () => ({ id: "glm-5.3-flash", provider: "zai" });
	ctx.modelRegistry.stream = () =>
		fakeStream({
			...ASSISTANT(""),
			stopReason: "error",
			errorMessage:
				'429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-15 22:52:40"}',
		});

	await pi.commands.rename.handler("", ctx);
	assert.equal(
		isModelMemoFailed("zai/glm-5.3-flash"),
		true,
		"the real zai weekly-limit exhaustion (code 1310) sits out the window",
	);
});

test("/rename works mid-turn; empty sessions still refuse", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const busy = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("mid-run outcome"))]);
	busy.isIdle = () => false;
	await pi.commands.rename.handler("", busy);
	assert.equal(pi.state.name, "Generated session title");

	const emptyPi = fakePi();
	registerSessionTitle(emptyPi);
	const empty = fakeCtx([]);
	await emptyPi.commands.rename.handler("", empty);
	assert.equal(emptyPi.state.name, undefined);
});

test("a trickling stream outlives the idle cap; a silent one is aborted and marked", async () => {
	setTitleIdleTimeoutForTesting(50);
	try {
		// tokens keep arriving every 30ms — slower than the cap wall-clock,
		// never 50ms silent, so the title completes
		const pi = fakePi();
		registerSessionTitle(pi);
		const ctx = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("fixed"))]);
		ctx.modelRegistry.stream = () => ({
			async *[Symbol.asyncIterator]() {
				for (let i = 0; i < 5; i++) {
					await new Promise((r) => setTimeout(r, 30));
					yield { type: "message_start" };
				}
			},
			result: async () => ASSISTANT("Trickled title"),
		});
		await pi.commands.rename.handler("", ctx);
		assert.equal(pi.state.name, "Trickled title", "a streaming response is never borked");

		// total silence: the armed idle cap aborts, the candidate is marked
		const silentPi = fakePi();
		registerSessionTitle(silentPi);
		const silent = fakeCtx([msgEntry(USER("fix bug")), msgEntry(ASSISTANT("fixed"))]);
		silent.modelRegistry.find = () => ({ id: "glm-5.3-flash", provider: "zai" });
		silent.modelRegistry.stream = (_m, _c, options) => ({
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise((_, reject) => {
							options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
						}),
				};
			},
			result: () =>
				new Promise((_, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		await silentPi.commands.rename.handler("", silent);
		assert.equal(silentPi.state.name, undefined, "a silent stream produces no title");
		assert.equal(
			isModelMemoFailed("zai/glm-5.3-flash"),
			true,
			"the silent candidate sits out the cooldown",
		);
		assert.ok(
			silent.ui.notifications.some((n) => /renamed failed/.test(n.text)),
			"the abort surfaces as a failure",
		);
	} finally {
		setTitleIdleTimeoutForTesting(15_000);
	}
});
