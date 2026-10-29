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

// Background fan-out and chain: background:true returns immediately (run id
// echoes via the registry) and completions are delivered exclusively through
// the wake gate — fan-out queues one torus.delegation-result entry per run,
// chain queues exactly one entry for the whole pipeline's final outcome, and
// neither path emits a marker directly. The kill switch
// TORUS_DELEGATE_BACKGROUND=0 forces the blocking paths with a visible note.
// Fixture pattern follows tests/delegation-background.test.mjs: agents ride in
// via TORUS_ROOT, a fake engine emits one JSON message_end and exits 0.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-fanout-background-test-"));
process.env.TORUS_HOME = HOME;
process.env.TORUS_TMUX = "0";
process.env.TORUS_NOTIFY = "0";
delete process.env.TORUS_DELEGATE_BACKGROUND;

const ROOT = mkdtempSync(path.join(tmpdir(), "torus-fanout-fixture-root-"));
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

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fanout-engines-"));
const ARGS_ENGINE = path.join(ENGINE_DIR, "args-engine.sh");
writeFileSync(
	ARGS_ENGINE,
	'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TORUS_ARGS_DIR/spawn-$$.txt"\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(ARGS_ENGINE, 0o755);
process.env.TORUS_ARGS_DIR = ENGINE_DIR;
// One engine, two behaviors: a task whose text carries "fail me" exits 1 (the
// mixed-engine trick from tests/delegation-surface.test.mjs).
const MIXED_ENGINE = path.join(ENGINE_DIR, "mixed-engine.sh");
writeFileSync(
	MIXED_ENGINE,
	'#!/bin/sh\ncase "$*" in *"fail me"*) echo "engine exploded" >&2; exit 1 ;; esac\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(MIXED_ENGINE, 0o755);

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");
const team = await import("../extensions/team/index.ts");
const gate = await import("../extensions/wake-gate.ts");

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;
const sent = [];

// Tool capture follows tests/delegation-background.test.mjs: registerRoster
// installs the custom sender that forwards to pi.sendMessage, so the capture
// lives THERE (a module-level registry.setCustomSender would be overwritten).
// registerTeam rides the same fake pi to contribute torus_fanout/torus_chain.
// The fake pi's on() no-ops so the wake gate stays at its idle default and
// entries flush immediately — the unit path under test.
const tools = [];
const fakePi = {
	registerTool: (tool) => tools.push(tool),
	on: () => {},
	registerCommand: () => {},
	sendMessage: (message, options) => sent.push({ message, options }),
};
roster.registerRoster(fakePi);
team.registerTeam(fakePi);
const fanoutTool = tools.find((t) => t.name === "torus_fanout");
assert.ok(fanoutTool, "torus_fanout not registered");
const chainTool = tools.find((t) => t.name === "torus_chain");
assert.ok(chainTool, "torus_chain not registered");

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
	sessionManager: { getSessionId: () => "sess-fanout-background" },
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

function withEngine(bin, fn) {
	return async () => {
		process.env.TORUS_ENGINE_BIN = bin;
		try {
			return await fn();
		} finally {
			if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
			else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
		}
	};
}

test(
	"background fan-out returns immediately and queues one wake entry per run",
	withEngine(ARGS_ENGINE, async () => {
		registry.resetRegistryForTesting();
		gate._resetWakeGateForTesting();
		sent.length = 0;

		const startedAt = Date.now();
		const result = await fanoutTool.execute(
			"c1",
			{
				background: true,
				runs: [
					{ agent: "builder", task: "probe a", handle: "fa" },
					{ agent: "builder", task: "probe b", handle: "fb" },
					{ agent: "builder", task: "probe c", handle: "fc" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.ok(Date.now() - startedAt < 3000, "tool must return without waiting for the runs");

		assert.equal(result.details.background, true);
		assert.deepEqual(
			result.details.entries.map((e) => e.handle),
			["fa", "fb", "fc"],
			"handle echoes come back in run order",
		);
		for (const entry of result.details.entries) {
			assert.equal(typeof entry.delegationId, "string", "id echo once the registry record exists");
		}
		assert.match(result.content[0].text, /background fan-out started — 3 runs/);
		assert.match(result.content[0].text, /torus_results/);

		await waitForSettled();
		await waitFor(() => backgroundEntries().length === 3, "fanout wake entries");
		const entries = backgroundEntries();
		assert.equal(entries.length, 3, "exactly one wake entry per completed run");
		assert.deepEqual(
			sent.filter((s) => s.message.customType === "torus.delegation-result").length,
			3,
			"no directly emitted result markers ride along — the gate is the only delivery path",
		);
		assert.deepEqual(
			entries.map((e) => e.message.details.handle).sort(),
			["fa", "fb", "fc"],
			"each entry carries its run's bare handle (renderers prepend @)",
		);
		for (const { message, options } of entries) {
			assert.equal(message.customType, "torus.delegation-result");
			assert.equal(message.details.background, true);
			assert.equal(message.details.ok, true);
			assert.equal(message.details.agent, "builder");
			assert.match(message.content[0].text, /background delegation finished/);
			assert.equal(options?.triggerTurn, true);
			assert.equal(options?.deliverAs, "followUp");
		}
	}),
);

test(
	"a failing fan-out run delivers its own entry with ok:false",
	withEngine(MIXED_ENGINE, async () => {
		registry.resetRegistryForTesting();
		gate._resetWakeGateForTesting();
		sent.length = 0;

		const result = await fanoutTool.execute(
			"c2",
			{
				background: true,
				runs: [
					{ agent: "builder", task: "healthy run", handle: "alive2" },
					{ agent: "builder", task: "fail me please", handle: "dead2" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.background, true);

		await waitForSettled();
		await waitFor(() => backgroundEntries().length === 2, "mixed-outcome wake entries");
		const entries = backgroundEntries();
		assert.equal(entries.length, 2, "both runs still deliver exactly one entry each");
		const failed = entries.find((e) => e.message.details.handle === "dead2");
		assert.ok(failed, "the failed run's entry is present");
		assert.equal(failed.message.details.ok, false);
		assert.match(failed.message.content[0].text, /background delegation FAILED/);
		const healthy = entries.find((e) => e.message.details.handle === "alive2");
		assert.ok(healthy, "the healthy run's entry is present");
		assert.equal(healthy.message.details.ok, true);
	}),
);

test(
	"TORUS_DELEGATE_BACKGROUND=0 forces blocking fan-out with a visible note",
	withEngine(ARGS_ENGINE, async () => {
		registry.resetRegistryForTesting();
		gate._resetWakeGateForTesting();
		sent.length = 0;
		process.env.TORUS_DELEGATE_BACKGROUND = "0";

		try {
			const result = await fanoutTool.execute(
				"c3",
				{
					background: true,
					runs: [
						{ agent: "builder", task: "forced a", handle: "forced-a" },
						{ agent: "builder", task: "forced b", handle: "forced-b" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			assert.equal(
				result.details.background,
				undefined,
				"no background details on the blocking path",
			);
			assert.equal(result.details.ok, 2, "the blocking result still settles both runs");
			assert.match(result.content[0].text, /fan-out complete in/);
			assert.match(
				result.content[0].text,
				/disabled via TORUS_DELEGATE_BACKGROUND=0 — ran blocking/,
			);
			assert.equal(
				backgroundEntries().length,
				0,
				"forced blocking must not queue a background wake entry",
			);
		} finally {
			delete process.env.TORUS_DELEGATE_BACKGROUND;
		}
	}),
);

test(
	"background chain returns immediately and queues exactly one entry on the final outcome",
	withEngine(ARGS_ENGINE, async () => {
		registry.resetRegistryForTesting();
		gate._resetWakeGateForTesting();
		sent.length = 0;

		const startedAt = Date.now();
		const result = await chainTool.execute(
			"c4",
			{
				background: true,
				steps: [
					{ agent: "builder", task: "step one" },
					{ agent: "builder", task: "step two" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.ok(Date.now() - startedAt < 3000, "tool must return without waiting for the chain");

		assert.equal(result.details.background, true);
		assert.equal(result.details.steps, 2);
		assert.match(result.content[0].text, /background chain started — 2 steps/);
		assert.match(result.content[0].text, /torus_results/);

		await waitForSettled();
		await waitFor(() => backgroundEntries().length === 1, "chain wake entry");
		const entries = backgroundEntries();
		assert.equal(entries.length, 1, "exactly one wake entry for the whole chain");
		const { message, options } = entries[0];
		assert.equal(message.customType, "torus.delegation-result");
		assert.equal(message.details.background, true);
		assert.equal(message.details.ok, true);
		assert.equal(message.details.agent, "chain");
		assert.match(message.content[0].text, /background delegation finished/);
		assert.match(message.content[0].text, /chain complete/);
		assert.match(message.content[0].text, /torus_results/);
		assert.equal(typeof message.details.delegationId, "string", "the wake points at the last step");
		assert.equal(options?.triggerTurn, true);
		assert.equal(options?.deliverAs, "followUp");
	}),
);
