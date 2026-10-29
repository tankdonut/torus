import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Background delegations: torus_delegate with background:true returns
// immediately (run id echo via the registry), and each completion is delivered
// exclusively through the wake gate — one torus.delegation-result entry with
// the /agent-command summary shape, never a directly emitted marker that would
// queue as a pi follow-up and drain one wasted turn apiece. The kill switch
// TORUS_DELEGATE_BACKGROUND=0 forces the blocking path with a visible note.
// Fixture pattern follows tests/delegation-model.test.mjs: agents ride in via
// TORUS_ROOT, a fake engine emits one JSON message_end and exits 0.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-delegation-background-test-"));
process.env.TORUS_HOME = HOME;
process.env.TORUS_TMUX = "0";
process.env.TORUS_NOTIFY = "0";
delete process.env.TORUS_DELEGATE_BACKGROUND;

const ROOT = mkdtempSync(path.join(tmpdir(), "torus-background-fixture-root-"));
const FIXTURE_AGENTS = path.join(ROOT, "agents");
mkdirSync(FIXTURE_AGENTS, { recursive: true });
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const f of readdirSync(path.join(REPO_ROOT, "agents"))) {
	if (f.endsWith(".md")) {
		writeFileSync(
			path.join(FIXTURE_AGENTS, f),
			readFileSync(path.join(REPO_ROOT, "agents", f), "utf8"),
			"utf8",
		);
	}
}
process.env.TORUS_ROOT = ROOT;

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-background-engines-"));
const ARGS_ENGINE = path.join(ENGINE_DIR, "args-engine.sh");
writeFileSync(
	ARGS_ENGINE,
	'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TORUS_ARGS_DIR/spawn-$$.txt"\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(ARGS_ENGINE, 0o755);
process.env.TORUS_ARGS_DIR = ENGINE_DIR;

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");
const gate = await import("../extensions/wake-gate.ts");

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;
const sent = [];

// Tool capture follows tests/delegation-surface.test.mjs: registerRoster pushes
// its tools into a fake pi. registerRoster also installs its own custom sender
// that forwards to pi.sendMessage, so the capture lives THERE (a module-level
// registry.setCustomSender would be overwritten by it). The fake pi's on()
// no-ops so the wake gate stays at its idle default and entries flush
// immediately — the unit path under test.
const tools = [];
roster.registerRoster({
	registerTool: (tool) => tools.push(tool),
	on: () => {},
	registerCommand: () => {},
	sendMessage: (message, options) => sent.push({ message, options }),
});
const delegateTool = tools.find((t) => t.name === "torus_delegate");
assert.ok(delegateTool, "torus_delegate not registered");

after(() => {
	process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	registry.setCustomSender(() => {});
	gate._resetWakeGateForTesting();
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

const ctx = {
	ui: { setStatus: () => {} },
	sessionManager: { getSessionId: () => "sess-background" },
};

function backgroundEntries() {
	return sent.filter((s) => s.message.details?.background === true);
}

/** Bounded wait until no registry record is still running (fake engines settle fast). */
async function waitForSettled(deadlineMs = 5000) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const running = registry.listDelegations().some((r) => r.status === "running");
		if (!running) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail("background run did not settle within the deadline");
}

/** Bounded wait for a condition (wake entries land a microtask after the registry settles). */
async function waitFor(predicate, what, deadlineMs = 5000) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`${what} did not arrive within the deadline`);
}

test("fireDelegationsBackground queues one wake entry per completed run, no direct emit", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	sent.length = 0;

	const settled = roster.fireDelegationsBackground([
		{
			agent: "worker",
			handle: "bg-probe",
			start: async () => ({ ok: true, text: "probe result", details: {}, delegationId: null }),
		},
	]);
	await Promise.all(settled);

	assert.equal(sent.length, 1, "exactly one wake entry");
	const { message, options } = sent[0];
	assert.equal(
		message.customType,
		"torus.delegation-result",
		"single-entry flush keeps the marker type",
	);
	assert.match(
		message.content[0].text,
		/\[torus\] @bg-probe \(worker\) background delegation finished\./,
	);
	assert.match(message.content[0].text, /probe result/);
	assert.match(message.content[0].text, /torus_results/);
	assert.equal(message.details.handle, "bg-probe", "handle stays bare (renderers prepend @)");
	assert.equal(message.details.ok, true);
	assert.equal(message.details.background, true);
	assert.equal(typeof message.details.durationMs, "number");
	assert.equal(options?.triggerTurn, true);
	assert.equal(options?.deliverAs, "followUp");
});

test("a crashing background run still queues a FAILED entry instead of rejecting", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	sent.length = 0;

	const settled = roster.fireDelegationsBackground([
		{
			agent: "worker",
			handle: null,
			start: async () => {
				throw new Error("engine exploded");
			},
		},
	]);
	const outcomes = await Promise.all(settled);

	assert.equal(outcomes[0].ok, false);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.details.ok, false);
	assert.match(sent[0].message.content[0].text, /background delegation FAILED/);
});

test("torus_delegate background:true returns immediately and delivers via the wake gate", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	sent.length = 0;
	process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;

	try {
		const startedAt = Date.now();
		const result = await delegateTool.execute(
			"c1",
			{ agent: "builder", task: "probe background", handle: "bg-run", background: true },
			undefined,
			undefined,
			ctx,
		);
		assert.ok(Date.now() - startedAt < 3000, "tool must return without waiting for the run");

		assert.equal(result.details.background, true);
		assert.equal(result.details.handle, "bg-run");
		assert.equal(result.structuredContent.background, true);
		assert.equal(result.structuredContent.ok, true);
		assert.match(result.content[0].text, /background delegation started — @bg-run \(builder\)/);
		assert.match(result.content[0].text, /torus_results/);
		assert.equal(
			typeof result.structuredContent.delegationId,
			"string",
			"id echo lands once the registry record exists",
		);

		await waitForSettled();
		await waitFor(() => backgroundEntries().length === 1, "background wake entry");
		const entries = backgroundEntries();
		assert.equal(entries.length, 1, "exactly one wake entry for the completed run");
		assert.equal(entries[0].message.details.handle, "bg-run");
		assert.equal(entries[0].message.details.ok, true);
		assert.equal(entries[0].message.details.delegationId, result.structuredContent.delegationId);
		assert.match(entries[0].message.content[0].text, /background delegation finished/);
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}
});

test("TORUS_DELEGATE_BACKGROUND=0 forces blocking with a visible note", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	sent.length = 0;
	process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;
	process.env.TORUS_DELEGATE_BACKGROUND = "0";

	try {
		const result = await delegateTool.execute(
			"c2",
			{ agent: "builder", task: "probe forced blocking", handle: "forced", background: true },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(
			result.details.background,
			undefined,
			"no background details on the blocking path",
		);
		assert.match(result.content[0].text, /disabled via TORUS_DELEGATE_BACKGROUND=0 — ran blocking/);
		assert.match(
			result.content[0].text,
			/done/,
			"the blocking result still carries the run output",
		);
		assert.equal(
			backgroundEntries().length,
			0,
			"forced blocking must not queue a background wake entry",
		);
	} finally {
		delete process.env.TORUS_DELEGATE_BACKGROUND;
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}
});

test("torus_results reads a finished record by id, lists recent runs, and fails clean on unknown ids", async () => {
	registry.resetRegistryForTesting();
	gate._resetWakeGateForTesting();
	sent.length = 0;

	const resultsTool = tools.find((t) => t.name === "torus_results");
	assert.ok(resultsTool, "torus_results not registered");

	await registry.startDelegation("seed-run-42", "builder", "m", null, "seed-handle");
	await registry.finishDelegation("seed-run-42", true, "full output tail", null);

	const single = await resultsTool.execute("c3", { id: "seed-run-42" }, undefined, undefined, ctx);
	assert.equal(single.isError, undefined);
	assert.match(single.content[0].text, /status: done/);
	assert.match(single.content[0].text, /agent: builder/);
	assert.match(single.content[0].text, /handle: @seed-handle/);
	assert.ok(
		single.content[0].text.includes("full output tail"),
		"stored text rides the result verbatim",
	);
	assert.equal(single.structuredContent.id, "seed-run-42");
	assert.equal(typeof single.structuredContent.turns, "number");
	assert.equal(typeof single.structuredContent.cost, "number");

	const listed = await resultsTool.execute("c4", {}, undefined, undefined, ctx);
	const line = listed.content[0].text.split("\n").find((l) => l.includes("seed-run…"));
	assert.ok(line, "seeded record missing from the list");
	assert.match(line, /@seed-handle · builder · done · \d+s · seed-run…/);

	const prefixed = await resultsTool.execute("c5", { id: "seed-run" }, undefined, undefined, ctx);
	assert.equal(prefixed.isError, undefined, "the 8-char id preview from the list must resolve");
	assert.ok(prefixed.content[0].text.includes("full output tail"));

	const missing = await resultsTool.execute("c6", { id: "nope" }, undefined, undefined, ctx);
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /no delegation record with id nope/);
});
