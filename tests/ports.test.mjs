import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { formatDoctorReport } = await import("../extensions/doctor/index.ts");
const { buildAstgrepArgs } = await import("../extensions/astgrep/index.ts");
const { searchSessions } = await import("../extensions/sessions/index.ts");
const { detectKeyword, DEFAULT_KEYWORDS, mergeKeywords } = await import(
	"../extensions/prompts/index.ts"
);
const { PERSONA_COLORS, buildStatus, personaFg, registerUi, setStatusExtras, setStatusModel } =
	await import("../extensions/ui/index.ts");
const { goalChipFor } = await import("../extensions/goal/index.ts");
const { AGENTS } = await import("../extensions/roster/index.ts");
const { setSessionPersona } = await import("../extensions/registry.js");

test("persona colors: every roster agent has a distinct RGB assignment", () => {
	for (const agent of AGENTS) {
		assert.ok(PERSONA_COLORS[agent.name], `no color for ${agent.name}`);
	}
	assert.equal(new Set(Object.values(PERSONA_COLORS)).size, Object.keys(PERSONA_COLORS).length);
	assert.deepEqual(PERSONA_COLORS["leader"], [86, 182, 194]);
});

test("personaFg wraps text in truecolor and unknown personas pass through", () => {
	assert.equal(
		personaFg("leader", "persona: leader"),
		"\x1b[38;2;86;182;194mpersona: leader\x1b[39m",
	);
	assert.equal(personaFg("unknown", "plain"), "plain");
});

test("buildStatus: plain mode keeps separators; themed mode paints segments and persona", () => {
	setSessionPersona("leader");
	setStatusModel(undefined, undefined);
	const fakeTheme = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => `*${text}*`,
	};
	const plain = buildStatus();
	assert.match(plain, /leader/);
	assert.ok(!plain.includes("persona:"), "verbose persona prefix should be gone");
	assert.ok(!plain.includes("[pi]"), "stock engine tag should be hidden");
	assert.ok(plain.includes(" · "), "plain separator missing");

	const themed = buildStatus(fakeTheme);
	assert.ok(themed.includes("<accent>*torus*</accent>"), "brand not accent-bold");
	assert.ok(themed.includes("<dim> · </dim>"), "separator not dimmed");
	assert.ok(themed.includes(personaFg("leader", "leader")), "persona chip not RGB-painted");
	assert.ok(!themed.includes("<warning>"), "goal gold leaked into status");
	setSessionPersona(null);
	assert.ok(!buildStatus().includes("leader"), "persona segment should drop when unset");
});

test("buildStatus: model and thinking effort are persona-colored and shortened", () => {
	setSessionPersona("builder");
	setStatusModel("zai/glm-4.7", "high");
	const fakeTheme = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => `*${text}*`,
	};
	const themed = buildStatus(fakeTheme);
	assert.ok(themed.includes(personaFg("builder", "glm-4.7")), "model not persona-colored");
	assert.ok(!themed.includes("zai/"), "provider prefix not stripped");
	assert.ok(themed.includes(personaFg("builder", "high")), "effort not persona-colored");
	assert.ok(themed.includes("<dim>"), "providers should stay dim");
	setStatusModel(undefined, undefined);
	const bare = buildStatus(fakeTheme);
	assert.ok(!bare.includes("glm-4.7"), "model should drop when unset");
	assert.ok(!bare.includes("high"), "effort should drop when unset");
	setSessionPersona(null);
});

test("registerUi: model/effort state self-heals from ctx when events were missed", () => {
	const handlers = {};
	registerUi({
		on: (event, handler) => (handlers[event] = handler),
		getMcpServers: () => [],
		getActiveTools: () => [],
	});
	const setStatusCalls = [];
	const ctx = {
		ui: {
			setStatus: (key, value) => setStatusCalls.push([key, value]),
			theme: { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `*${text}*` },
		},
		model: undefined,
		thinkingLevel: undefined,
	};
	setSessionPersona("leader");
	setStatusModel(undefined, undefined);

	// startup before the model was selected: no model in the line
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.ok(!setStatusCalls[0][1].includes("glm"), "no model expected yet");

	// same-model persona switch: engine fires NO model_select — a later
	// turn_start must still backfill model+effort from live ctx
	ctx.model = { id: "zai/glm-4.7" };
	ctx.thinkingLevel = "high";
	handlers["turn_start"]({ type: "turn_start" }, ctx);
	assert.ok(
		setStatusCalls.at(-1)[1].includes(personaFg("leader", "glm-4.7")),
		"model must backfill from ctx without a model_select event",
	);
	assert.ok(
		setStatusCalls.at(-1)[1].includes(personaFg("leader", "high")),
		"effort must backfill from ctx without a thinking_level_select event",
	);
	setSessionPersona(null);
	setStatusModel(undefined, undefined);
});

test("buildStatus: engine tag only when overridden", () => {
	setSessionPersona("leader");
	setStatusModel(undefined, undefined);
	assert.ok(!buildStatus().includes("[pi]"), "stock engine tag should be hidden");
	process.env["TORUS_ENGINE"] = "pi-dev";
	try {
		assert.ok(buildStatus().includes("[pi-dev]"), "override tag missing");
	} finally {
		delete process.env["TORUS_ENGINE"];
	}
	setSessionPersona(null);
});

test("buildStatus: MCP count and goal chip render on the torus line", () => {
	setSessionPersona("leader");
	setStatusModel("zai/glm-4.7", "high");
	setStatusExtras(null, null);
	const fakeTheme = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => `*${text}*`,
	};
	const bare = buildStatus(fakeTheme);
	assert.ok(!bare.includes("MCP"), "MCP segment should drop when none registered");
	assert.ok(!bare.includes("▶"), "goal segment should drop when unset");

	setStatusExtras(
		{ connected: 0, registered: 2 },
		{ head: "ship the frobnicator", status: "active" },
	);
	const loaded = buildStatus(fakeTheme);
	assert.ok(loaded.includes("<warning>MCP 0</warning>"), "down servers should warn");
	assert.ok(loaded.includes("<warning>▶ ship the frobnicator</warning>"), "active goal chip");

	setStatusExtras(
		{ connected: 2, registered: 2 },
		{ head: "ship the frobnicator", status: "paused" },
	);
	const healthy = buildStatus(fakeTheme);
	assert.ok(healthy.includes("<success>MCP 2</success>"), "connected servers should be success");
	assert.ok(healthy.includes("<dim>⏸ ship the frobnicator</dim>"), "paused goal chip should dim");
	setStatusExtras(null, null);
	setSessionPersona(null);
});

test("goalChipFor: active/paused heads truncated to 48 chars, complete and empty drop", () => {
	const long = "x".repeat(60);
	assert.deepEqual(goalChipFor({ goal: long, status: "active", createdAt: 0, notes: [] }), {
		head: `${"x".repeat(48)}…`,
		status: "active",
	});
	assert.equal(
		goalChipFor({ goal: "  multi\nline  goal ", status: "paused", createdAt: 0, notes: [] })?.head,
		"multi line goal",
	);
	assert.equal(
		goalChipFor({ goal: "done thing", status: "complete", createdAt: 0, notes: [] }),
		undefined,
	);
	assert.equal(goalChipFor(null), undefined);
	assert.equal(goalChipFor({ goal: "   ", status: "active", createdAt: 0, notes: [] }), undefined);
});

test("built-in keywords: trio present, user file overrides same key, new keys merge", () => {
	assert.deepEqual(Object.keys(DEFAULT_KEYWORDS).sort(), ["hyperplan", "team", "ultrawork"]);
	const merged = mergeKeywords({ ultrawork: "custom", mine: "new" });
	assert.equal(merged.ultrawork, "custom");
	assert.equal(merged.mine, "new");
	assert.equal(merged.hyperplan, DEFAULT_KEYWORDS.hyperplan);
});
const { validateMonitorSpec } = await import("../extensions/monitor/index.ts");

test("formatDoctorReport: icons, summary line, fail/warn counts", () => {
	const checks = [
		{ name: "engine", status: "ok", detail: "pi 0.99.1" },
		{ name: "lsp", status: "warn", detail: "absent" },
		{ name: "auth", status: "fail", detail: "missing" },
	];
	const report = formatDoctorReport(checks);
	assert.match(report, /3 checks: 1 fail, 1 warn/);
	assert.match(report, /✓ engine: pi 0.99.1/);
	assert.match(report, /! lsp: absent/);
	assert.match(report, /✗ auth: missing/);
});

test("buildAstgrepArgs: pattern, language, paths, rewrite ordering", () => {
	assert.deepEqual(buildAstgrepArgs("foo($X)", "ts"), ["run", "-p", "foo($X)", "-l", "ts", "."]);
	assert.deepEqual(buildAstgrepArgs("p", undefined, ["a", "b"], "r($X)"), [
		"run",
		"-p",
		"p",
		"--rewrite",
		"r($X)",
		"a",
		"b",
	]);
});

test("searchSessions: finds matches with uuid, project, snippet; limit respected", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-sessions-"));
	const proj = path.join(root, "--proj-a--");
	mkdirSync(proj);
	const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
	writeFileSync(
		path.join(proj, `2026-09-30T10-00-00-000Z_${sessionId}.jsonl`),
		'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"fix the mailbox cursors please"}]}}\n',
	);
	const hits = searchSessions("mailbox cursors", root, 5);
	assert.equal(hits.length, 1);
	assert.equal(hits[0]?.sessionId, sessionId);
	assert.equal(hits[0]?.project, "--proj-a--");
	assert.match(hits[0]?.snippet ?? "", /mailbox cursors/);
	assert.equal(searchSessions("nonexistent", root, 5).length, 0);
});

test("detectKeyword: word-boundary match, regex metachars safe, first hit wins", () => {
	const map = { ultrawork: "full precision mode", "c++": "lang mode" };
	assert.equal(detectKeyword("let's ultrawork this", map), "ultrawork");
	assert.equal(detectKeyword("ultraworking is not a keyword hit", map), null);
	assert.equal(detectKeyword("regex c++ literal", map), "c++");
});

test("validateMonitorSpec: name charset and interval floor", () => {
	assert.equal(validateMonitorSpec("ci-tail", 30), null);
	assert.equal(validateMonitorSpec("Bad Name", 30) !== null, true);
	assert.equal(validateMonitorSpec("ok", 4) !== null, true);
});

test("splitMouseBuffer: complete wheels dispatch, split fragments hold, dead fragments free trailing keys", async () => {
	const { splitMouseBuffer } = await import("../extensions/browser/index.ts");
	let ticks = 0;
	const wheel = () => {
		ticks += 1;
	};
	const complete = splitMouseBuffer("\x1b[<65;10;8M", wheel);
	assert.equal(complete.keys, "", "complete wheel consumed");
	assert.equal(complete.held, "");
	assert.equal(ticks, 1, "wheel dispatched");

	const split = splitMouseBuffer("\x1b[<6", wheel);
	assert.deepEqual([split.keys, split.held], ["", "\x1b[<6"], "partial wheel held for next chunk");

	const merged = splitMouseBuffer(`${split.held}5;10;8M`, wheel);
	assert.equal(merged.keys, "", "held prefix completes across chunks");

	const freedEsc = splitMouseBuffer("\x1b[<6\x1b", wheel);
	assert.equal(freedEsc.keys, "\x1b", "dead fragment stripped, ESC passes through");
	assert.equal(freedEsc.held, "");

	const plain = splitMouseBuffer("jk", wheel);
	assert.equal(plain.keys, "jk", "plain keys untouched");
});

test("personaModel maps personas to session models (explicit model field honored, chain head fallback)", async () => {
	const { personaModel, parseAgentFile } = await import("../extensions/roster/index.ts");
	const leader = personaModel("leader");
	const explorer = personaModel("explorer");
	assert.ok(leader?.includes("glm-5.3"), `leader maps to a glm-5.3 model, got ${String(leader)}`);
	assert.ok(
		explorer?.includes("flash"),
		`explorer maps to the flash chain, got ${String(explorer)}`,
	);
	assert.equal(personaModel("does-not-exist"), null, "unknown persona has no model");

	const pinned = parseAgentFile(
		"pinned.md",
		"---\nname: probe\ndescription: probe agent\nchain: fast\nmodel: zai/glm-5.3-flash\n---\nbody",
	);
	assert.equal(pinned?.model, "zai/glm-5.3-flash", "explicit model frontmatter parses");
});
