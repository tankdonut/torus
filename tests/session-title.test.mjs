import assert from "node:assert/strict";
import { test } from "node:test";

const {
	sanitizeTitle,
	messageText,
	firstUserPrompt,
	sessionDigest,
	resolveTitleModel,
	registerSessionTitle,
} = await import("../extensions/session-title/index.ts");

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

test("sessionDigest: interleaves roles, skips noise, truncates head+tail", () => {
	const entries = [
		msgEntry(USER("fix the hashline edit bug")),
		msgEntry(ASSISTANT("I'll start by reading the file.")),
		msgEntry({ type: "usage", id: "u1", parentId: null, timestamp: "0", kind: "chat" }),
		msgEntry({ role: "custom", customType: "torus.memory-applied", content: "x", display: false }),
		msgEntry(USER("also add tests")),
		msgEntry(ASSISTANT("Done — tests added and passing.")),
	];
	const digest = sessionDigest(entries);
	assert.match(digest, /^User: fix the hashline edit bug/);
	assert.match(digest, /Assistant: I'll start by reading the file\./);
	assert.match(digest, /User: also add tests/);
	assert.match(digest, /Assistant: Done — tests added and passing\./);
	assert.equal(digest.includes("torus.memory-applied"), false);
	assert.equal(digest.includes("usage"), false);

	assert.equal(sessionDigest([]), "");

	const fat = [...Array.from({ length: 40 }, (_, i) => msgEntry(USER(`${i} ${"x".repeat(300)}`)))];
	const capped = sessionDigest(fat);
	assert.ok(capped.length < 7000, `digest must stay bounded, got ${capped.length}`);
	assert.match(capped, /…truncated…/);
	assert.match(capped, /39 /, "tail must keep the latest turn");
});

test("resolveTitleModel: override -> authed fast default -> session model -> undefined", () => {
	const makeRegistry = (found, authed = true) => ({
		find: (_p, _m) => (found ? { id: "m" } : undefined),
		hasConfiguredAuth: () => authed,
	});
	const sessionModel = { id: "session" };

	assert.equal(resolveTitleModel("custom/big", makeRegistry(true), undefined).id, "m");
	assert.equal(resolveTitleModel(undefined, makeRegistry(true), sessionModel).id, "m");
	assert.equal(resolveTitleModel(undefined, makeRegistry(false), sessionModel).id, "session");
	assert.equal(resolveTitleModel(undefined, makeRegistry(true, false), sessionModel).id, "session");
	assert.equal(resolveTitleModel(undefined, makeRegistry(false), undefined), undefined);
	// malformed override (no slash) falls through, not crashes
	assert.equal(resolveTitleModel("nonsense", makeRegistry(true), sessionModel).id, "m");
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

function fakeCtx(entries, { reply } = {}) {
	return {
		sessionManager: { getEntries: () => entries },
		model: { id: "session" },
		modelRegistry: {
			find: () => ({ id: "fast" }),
			hasConfiguredAuth: () => true,
			complete: async () => ASSISTANT(reply ?? "Generated session title"),
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

test("auto-title retries across turns while unnamed, then gives up", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	let calls = 0;
	const ctx = fakeCtx([msgEntry(USER("first ask"))], {
		reply: undefined,
	});
	ctx.modelRegistry.complete = async () => {
		calls += 1;
		throw new Error("network down");
	};
	pi.handlers.session_start({}, ctx);
	for (let i = 0; i < 6; i++) {
		await pi.handlers.turn_end({ type: "turn_end" }, ctx);
		await flush();
	}
	assert.equal(pi.state.name, undefined);
	assert.equal(calls, 3, "must stop after MAX_AUTO_ATTEMPTS");
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
	ctx.modelRegistry.complete = async (_model, context) => {
		seenInstruction = context.messages[0].content;
		return ASSISTANT("Hashline edit bug fix");
	};
	await pi.commands.rename.handler("", ctx);
	assert.equal(pi.state.name, "Hashline edit bug fix");
	assert.match(seenInstruction, /User: fix bug/);
	assert.match(seenInstruction, /Assistant: fixed via X/);

	// hint rides along
	let seenHint = "";
	ctx.modelRegistry.complete = async (_m, c) => {
		seenHint = c.messages[0].content;
		return ASSISTANT("Focused title");
	};
	await pi.commands.rename.handler("the auth refactor", ctx);
	assert.match(seenHint, /focus: the auth refactor/);
	assert.equal(pi.state.name, "Focused title");
});

test("/rename refuses mid-turn and on empty sessions", async () => {
	const pi = fakePi();
	registerSessionTitle(pi);
	const busy = fakeCtx([msgEntry(USER("hi"))]);
	busy.isIdle = () => false;
	await pi.commands.rename.handler("", busy);
	assert.equal(pi.state.name, undefined);

	const empty = fakeCtx([]);
	await pi.commands.rename.handler("", empty);
	assert.equal(pi.state.name, undefined);
});
