import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The @-mention surface: parsing, target resolution over the shared registry,
// routing (delegation steer vs member mailbox), editor completion merging, and
// prose coloring. Fixtures drive the pure seams plus the real registry state
// under an isolated TORUS_HOME, mirroring tests/team-mail.test.mjs.

const HOME = mkdtempSync(path.join(tmpdir(), "torus-handles-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const handles = await import("../extensions/handles/index.ts");
const registry = await import("../extensions/registry.ts");
const runtime = await import("../extensions/team-runtime.ts");

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

const suiteTeams = [];

function freshRegistry() {
	registry.resetRegistryForTesting();
	for (const teamId of suiteTeams.splice(0)) registry.dropTeam(teamId);
}

function fakeTeam(teamId, members) {
	suiteTeams.push(teamId);
	registry.registerTeam({
		id: teamId,
		name: teamId,
		objective: "test",
		status: "active",
		dir: path.join(HOME, teamId),
		members: members.map((member, index) => ({
			id: `${teamId}/${member.name}`,
			name: member.name,
			agent: "builder",
			model: "fast",
			status: member.status,
			sessionId: null,
			startedAt: index,
			mailboxDir: "",
		})),
		createdAt: 1,
	});
}

test("parseMentionInput splits name from message", () => {
	assert.deepEqual(handles.parseMentionInput("@scout look at the failing test"), {
		name: "scout",
		message: "look at the failing test",
	});
	assert.deepEqual(handles.parseMentionInput("@scout"), { name: "scout", message: null });
	assert.deepEqual(handles.parseMentionInput("@scout   "), { name: "scout", message: null });
	assert.deepEqual(handles.parseMentionInput("@scout line one\nline two"), {
		name: "scout",
		message: "line one\nline two",
	});
});

test("parseMentionInput rejects paths, prose, and emails", () => {
	assert.equal(handles.parseMentionInput("@file.md summary"), null);
	assert.equal(handles.parseMentionInput("@src/foo.ts"), null);
	assert.equal(handles.parseMentionInput("steer @scout now"), null);
	assert.equal(handles.parseMentionInput("a@b"), null);
	assert.equal(handles.parseMentionInput("plain prompt"), null);
});

test("liveMentionTargets lists running handles and active members only", async () => {
	freshRegistry();
	await registry.startDelegation(
		"11111111-1111-1111-1111-111111111111",
		"builder",
		"fast",
		null,
		"scout",
	);
	await registry.startDelegation(
		"22222222-2222-2222-2222-222222222222",
		"builder",
		"fast",
		null,
		"done-one",
	);
	await registry.finishDelegation("22222222-2222-2222-2222-222222222222", true, "fin");
	await registry.startDelegation("team-1/ember", "builder", "fast", null, "ember");
	fakeTeam("team-1", [
		{ name: "ember", status: "working" },
		{ name: "ghost", status: "stopped" },
	]);
	fakeTeam("team-2", [{ name: "relay", status: "idle" }]);

	const names = handles.liveMentionTargets().map((target) => `${target.kind}:${target.name}`);
	assert.deepEqual(names, ["run:scout", "member:ember", "member:relay"]);
});

test("resolveMention is case-insensitive", async () => {
	freshRegistry();
	await registry.startDelegation(
		"11111111-1111-1111-1111-111111111111",
		"builder",
		"fast",
		null,
		"Scout",
	);
	assert.equal(handles.resolveMention("scout").length, 1);
});

test("routeMention steers a unique running delegation through the registry control", async () => {
	freshRegistry();
	await registry.startDelegation(
		"11111111-1111-1111-1111-111111111111",
		"builder",
		"fast",
		null,
		"scout",
	);
	const steered = [];
	registry.attachControl("11111111-1111-1111-1111-111111111111", {
		stop: () => {},
		steer: (text) => {
			steered.push(text);
			return true;
		},
	});

	const result = await handles.routeMention({ name: "scout", message: "pivot to the parser" });
	assert.equal(result.action, "handled");
	assert.match(result.notify.text, /steered @scout/);
	assert.deepEqual(steered, ["pivot to the parser"]);
});

test("routeMention reports a run that cannot take input", async () => {
	freshRegistry();
	await registry.startDelegation(
		"11111111-1111-1111-1111-111111111111",
		"builder",
		"fast",
		null,
		"scout",
	);

	const result = await handles.routeMention({ name: "scout", message: "hello" });
	assert.equal(result.action, "handled");
	assert.equal(result.notify.level, "error");
	assert.match(result.notify.text, /not accepting input/);
});

test("routeMention mails a team member instead of steering its registry record", async () => {
	freshRegistry();
	fakeTeam("alpha", [{ name: "ember", status: "idle" }]);
	// The member's registry record must not become a steer target.
	await registry.startDelegation("alpha/ember", "builder", "fast", null, "ember");
	registry.attachControl("alpha/ember", {
		stop: () => {},
		steer: () => {
			assert.fail("member registry record must never be steered directly");
		},
	});

	const result = await handles.routeMention({ name: "ember", message: "pick up the parse task" });
	assert.equal(result.action, "handled");
	assert.match(result.notify.text, /mail queued for @ember/);
	const inbox = readFileSync(
		path.join(runtime.teamDir("alpha"), "mailboxes", "ember", "inbox.md"),
		"utf8",
	);
	assert.match(inbox, /FROM lead:/);
	assert.match(inbox, /pick up the parse task/);
});

test("routeMention reports a bare mention as target status", async () => {
	freshRegistry();
	await registry.startDelegation(
		"11111111-1111-1111-1111-111111111111",
		"builder",
		"fast",
		null,
		"scout",
	);
	const result = await handles.routeMention({ name: "scout", message: null });
	assert.equal(result.action, "handled");
	assert.match(result.notify.text, /@scout · builder run/);
});

test("routeMention refuses ambiguous names and continues unknown ones", async () => {
	freshRegistry();
	await registry.startDelegation(
		"11111111-1111-1111-1111-111111111111",
		"builder",
		"fast",
		null,
		"ember",
	);
	fakeTeam("alpha", [{ name: "ember", status: "idle" }]);

	const ambiguous = await handles.routeMention({ name: "ember", message: "go" });
	assert.equal(ambiguous.action, "handled");
	assert.equal(ambiguous.notify.level, "error");
	assert.match(ambiguous.notify.text, /more than one target/);

	assert.deepEqual(await handles.routeMention({ name: "nobody", message: "go" }), {
		action: "continue",
	});
});

test("mentionTokenAt finds the token at the cursor boundary", () => {
	assert.equal(handles.mentionTokenAt("steer @sco"), "@sco");
	assert.equal(handles.mentionTokenAt("@sco"), "@sco");
	assert.equal(handles.mentionTokenAt("(@sco"), "@sco");
	assert.equal(handles.mentionTokenAt("email a@b"), null);
	assert.equal(handles.mentionTokenAt("@file.md"), null);
	assert.equal(handles.mentionTokenAt("plain text"), null);
});

function fakeCurrent(items = []) {
	return {
		getSuggestionsCalled: 0,
		async getSuggestions() {
			this.getSuggestionsCalled += 1;
			return items.length === 0
				? null
				: { items: items.map((value) => ({ value, label: value })), prefix: "@f" };
		},
		applyCompletion(lines, line, col, item) {
			return {
				lines: [...lines.slice(0, line), item.value, ...lines.slice(line + 1)],
				cursorLine: line,
				cursorCol: col,
			};
		},
	};
}

const runTarget = { kind: "run", name: "scout", delegationId: "d1", agent: "builder", turns: 2 };
const memberTarget = {
	kind: "member",
	name: "relay",
	teamId: "t1",
	teamName: "alpha",
	agent: "builder",
	memberStatus: "idle",
};

test("completion merges mention items ahead of file items", async () => {
	const current = fakeCurrent(["@file1.txt"]);
	const provider = handles.createHandlesAutocompleteProvider(current, () => [
		runTarget,
		memberTarget,
	]);
	const suggestions = await provider.getSuggestions(["steer @s"], 0, 8, {
		signal: new AbortController().signal,
	});
	assert.equal(suggestions.prefix, "@f");
	assert.deepEqual(
		suggestions.items.map((item) => item.value),
		["@scout", "@file1.txt"],
	);
	assert.match(suggestions.items[0].description, /steer · builder run/);
});

test("completion passes through without live matches or outside a mention token", async () => {
	const current = fakeCurrent(["@file1.txt"]);
	const provider = handles.createHandlesAutocompleteProvider(current, () => [
		runTarget,
		memberTarget,
	]);

	const outside = await provider.getSuggestions(["plain text"], 0, 10, {
		signal: new AbortController().signal,
	});
	assert.deepEqual(
		outside.items.map((item) => item.value),
		["@file1.txt"],
	);

	const unmatched = await provider.getSuggestions(["@zz"], 0, 3, {
		signal: new AbortController().signal,
	});
	assert.deepEqual(
		unmatched.items.map((item) => item.value),
		["@file1.txt"],
	);

	const idle = handles.createHandlesAutocompleteProvider(fakeCurrent([]), () => []);
	const empty = await idle.getSuggestions(["@s"], 0, 2, { signal: new AbortController().signal });
	assert.equal(empty, null);
});

test("completion with no file suggestions still offers mentions", async () => {
	const provider = handles.createHandlesAutocompleteProvider(fakeCurrent([]), () => [
		runTarget,
		memberTarget,
	]);
	const suggestions = await provider.getSuggestions(["@rel"], 0, 4, {
		signal: new AbortController().signal,
	});
	assert.equal(suggestions.prefix, "@rel");
	assert.deepEqual(
		suggestions.items.map((item) => item.value),
		["@relay"],
	);
});

test("applyCompletion delegates to the wrapped provider", () => {
	const provider = handles.createHandlesAutocompleteProvider(fakeCurrent([]), () => [runTarget]);
	const result = provider.applyCompletion(
		["@s rest"],
		0,
		7,
		{ value: "@scout", label: "@scout" },
		"@s",
	);
	assert.deepEqual(result.lines, ["@scout"]);
});

test("colorizeMentions paints live names, skips fences and unknown names", () => {
	handles.resetColoredNamesForTesting();
	const paint = (name) => `<${name}>`;
	const markdown = [
		"Ping @scout for the review.",
		"@relay on the next line colors too,",
		"",
		"```",
		"@scout must stay plain here",
		"```",
		"Unknown @stranger stays plain; so does a@scout and `@scout` inline.",
	].join("\n");
	const out = handles.colorizeMentions(markdown, paint, () => [runTarget, memberTarget]);
	assert.match(out, /Ping <scout> for the review/);
	assert.match(out, /<relay> on the next line colors too/);
	assert.match(out, /@scout must stay plain here/);
	assert.match(out, /Unknown @stranger stays plain/);
	assert.match(out, /so does a@scout and `@scout` inline/);
});

test("colorizeMentions remembers finished names for stable colors", () => {
	handles.resetColoredNamesForTesting();
	const live = ["scout"];
	const paint = (name) => `<${name}>`;
	const targets = () => (live.includes("scout") ? [{ ...runTarget, name: "scout" }] : []);
	assert.equal(handles.colorizeMentions("see @scout", paint, targets), "see <scout>");
	assert.equal(
		handles.colorizeMentions("see @scout", paint, () => []),
		"see <scout>",
	);
});

test("registerMentionColoring skips thinking, passes through without a theme, and paints prose", () => {
	handles.resetColoredNamesForTesting();
	const registered = [];
	const pi = {
		registerMarkdownTransformer: (transformer) => registered.push(transformer),
	};
	handles.registerMentionColoring(pi);
	assert.equal(registered.length, 1);
	const transformer = registered[0];

	assert.equal(transformer("hi @scout", { messageType: "assistant" }), "hi @scout");

	const slot = Symbol.for("torus.handles.theme.v1");
	globalThis[slot] = {
		fg: (_color, text) => `[painted ${text}]`,
	};
	try {
		const painted = handles.colorizeMentions(
			"hi @scout",
			(name) => `[painted @${name}]`,
			() => [runTarget],
		);
		assert.equal(painted, "hi [painted @scout]");
		assert.equal(transformer("hi @scout", { messageType: "assistant-thinking" }), "hi @scout");
	} finally {
		delete globalThis[slot];
	}
});
