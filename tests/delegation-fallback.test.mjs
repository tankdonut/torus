import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Chain-walk fallback visibility: every rejection a walk makes (provider 429,
// dead tail, engine-signaled model error) fires runDelegation's onFallback,
// streams a note into the torus_delegate tool block while the dead attempt
// burns, and trails the completed result text (details.fallbacks) on both
// success and failure.
//
// TORUS_HOME must land before the registry import — it derives the logs dir at
// module load. The fake engines key off the spawn's `--model` arg so the walk
// can fail on the chain head and succeed down-chain; rpc attempts die on close
// (no protocol), the JSON fallback consumes the emitted event.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-delegation-fallback-test-"));
process.env.TORUS_HOME = HOME;

const ROOT = mkdtempSync(path.join(tmpdir(), "torus-fallback-fixture-root-"));
const FIXTURE_AGENTS = path.join(ROOT, "agents");
mkdirSync(FIXTURE_AGENTS, { recursive: true });
writeFileSync(
	path.join(FIXTURE_AGENTS, "worker.md"),
	[
		"---",
		"name: worker",
		"description: Fixture chain-primary worker",
		"chain: primary",
		"---",
		"",
		"Fixture worker body.",
		"",
	].join("\n"),
	"utf8",
);
process.env.TORUS_ROOT = ROOT;

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fallback-engines-"));
// Errors only on the primary head; the flash candidate "succeeds" with an
// empty-text turn (token delta keeps the tail healthy) so the live update
// renders the progress line under the fallback note.
const HEAD_ERROR_ENGINE = path.join(ENGINE_DIR, "head-error-engine.sh");
writeFileSync(
	HEAD_ERROR_ENGINE,
	[
		"#!/bin/sh",
		'model=""; prev="";',
		'for a in "$@"; do [ "$prev" = "--model" ] && model="$a"; prev="$a"; done',
		'case "$model" in',
		"  zai/glm-5.3)",
		'    echo \'{"type":"session","id":"child-leg-head"}\'',
		'    echo \'{"type":"error","error":"429 rate limited"}\'',
		"    exit 0",
		"    ;;",
		"  zai/glm-5.3-flash)",
		'    echo \'{"type":"session","id":"child-leg-flash"}\'',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":""}],"usage":{"input":10,"output":20}}}\'',
		"    exit 0",
		"    ;;",
		"  *)",
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'',
		"    exit 0",
		"    ;;",
		"esac",
	].join("\n"),
	"utf8",
);
chmodSync(HEAD_ERROR_ENGINE, 0o755);
// Every candidate errors, with a newline-carrying error body the reason
// formatter must collapse to one line; the walk exhausts the whole chain.
const ALL_ERROR_ENGINE = path.join(ENGINE_DIR, "all-error-engine.sh");
writeFileSync(
	ALL_ERROR_ENGINE,
	'#!/bin/sh\necho \'{"type":"error","error":"503 upstream drain\\nretry later"}\'\nexit 0\n',
	"utf8",
);
chmodSync(ALL_ERROR_ENGINE, 0o755);

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");

// Built-in chain providers are credential-gated at resolution: dummy env
// values (presence only — nothing reads them) keep chain resolution hermetic.
const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;
const PREV_ZAI_KEY = process.env.ZAI_API_KEY;
const PREV_OPENCODE_KEY = process.env.OPENCODE_API_KEY;
process.env.ZAI_API_KEY = "torus-test-dummy";
process.env.OPENCODE_API_KEY = "torus-test-dummy";

after(() => {
	process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	if (PREV_ZAI_KEY === undefined) delete process.env.ZAI_API_KEY;
	else process.env.ZAI_API_KEY = PREV_ZAI_KEY;
	if (PREV_OPENCODE_KEY === undefined) delete process.env.OPENCODE_API_KEY;
	else process.env.OPENCODE_API_KEY = PREV_OPENCODE_KEY;
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

// Dead attempts enter the session's no-work cooldown; clear it between tests
// so each starts from the unfiltered chain.
beforeEach(() => roster.resetFailureMemoForTesting());

async function withEngine(engineBin, fn) {
	process.env.TORUS_ENGINE_BIN = engineBin;
	try {
		return await fn();
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}
}

test("fallbackReason collapses error text and falls back to the exit code", () => {
	assert.equal(roster.fallbackReason(1), "exit 1");
	assert.equal(roster.fallbackReason(0, "   "), "exit 0");
	assert.equal(roster.fallbackReason(0, "429\n\nrate   limited"), "429 rate limited");
	assert.equal(roster.fallbackReason(0, "\tmulti\nline\traw\n\n"), "multi line raw");
	const long = "x".repeat(400);
	const reason = roster.fallbackReason(0, long);
	assert.ok(reason.length <= 164, "long error text caps around 160 chars");
	assert.ok(reason.startsWith("x".repeat(160)), "the cap keeps the head of the error");
});

test("formatFallbackNote renders fall-back and chain-exhausted lines", () => {
	assert.equal(
		roster.formatFallbackNote({
			from: "zai/glm-5.3",
			to: "zai/glm-5.3-flash",
			exitCode: 0,
			lastError: "429 rate limited",
			isLast: false,
		}),
		"↻ zai/glm-5.3 produced no work (429 rate limited) — falling back to zai/glm-5.3-flash",
	);
	assert.equal(
		roster.formatFallbackNote({
			from: "zai/glm-5.3-flash",
			to: null,
			exitCode: 1,
			isLast: true,
		}),
		"↻ zai/glm-5.3-flash produced no work (exit 1) — chain exhausted",
	);
});

test("a head rejection fires onFallback with from/to/lastError and marks the cooldown", async () => {
	registry.resetRegistryForTesting();
	registry.setCustomSender(() => {});
	const events = [];
	const outcome = await withEngine(HEAD_ERROR_ENGINE, () =>
		roster.runDelegation(
			"worker",
			"probe head error",
			undefined,
			undefined,
			null,
			null,
			null,
			undefined,
			undefined,
			{ onFallback: (event) => events.push(event) },
		),
	);
	assert.equal(outcome.ok, true, "the walk recovered on the flash candidate");
	assert.equal(outcome.details.model, "zai/glm-5.3-flash");
	assert.deepEqual(
		events.map((e) => [e.from, e.to, e.exitCode, e.lastError, e.isLast]),
		[["zai/glm-5.3", "zai/glm-5.3-flash", 0, "429 rate limited", false]],
		"one event: the rejected head moving down-chain",
	);
	assert.equal(roster.isModelMemoFailed("zai/glm-5.3"), true, "the rejected head sits out");
	assert.equal(roster.isModelMemoFailed("zai/glm-5.3-flash"), false);
	const record = registry.listDelegations().find((r) => r.agent === "worker");
	assert.ok(record, "the delegation record exists");
	assert.equal(
		record.sessionId,
		"child-leg-flash",
		"the live session follows the leg doing work, not the dead head",
	);
	registry.setCustomSender(() => {});
});

test("an exhausted walk marks the last candidate with isLast and to null", async () => {
	registry.resetRegistryForTesting();
	registry.setCustomSender(() => {});
	const events = [];
	const outcome = await withEngine(ALL_ERROR_ENGINE, () =>
		roster.runDelegation(
			"worker",
			"probe exhaust",
			undefined,
			undefined,
			null,
			null,
			null,
			undefined,
			undefined,
			{ onFallback: (event) => events.push(event) },
		),
	);
	assert.equal(outcome.ok, false, "every candidate failed");
	assert.equal(events.length, 3, "every rejected candidate including the last fired");
	assert.deepEqual(
		events.map((e) => e.from),
		["zai/glm-5.3", "zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
		"the events follow the primary chain in order",
	);
	const last = events[events.length - 1];
	assert.equal(last.to, null, "the last candidate has nowhere to fall back to");
	assert.equal(last.isLast, true);
	assert.match(outcome.text, /chain exhausted/, "the durable note names the exhaustion");
	assert.match(
		outcome.text,
		/503 upstream drain retry later/,
		"the multiline error text collapses to one line in the note",
	);
	registry.setCustomSender(() => {});
});

test("torus_delegate streams the note live and carries it in the result + details.fallbacks", async () => {
	registry.resetRegistryForTesting();
	const tools = [];
	roster.registerRoster({
		registerTool: (t) => tools.push(t),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	});
	const delegate = tools.find((t) => t.name === "torus_delegate");
	assert.ok(delegate, "torus_delegate not registered");
	const updates = [];
	const customs = [];
	registry.setCustomSender((message) => customs.push(message));

	const result = await withEngine(HEAD_ERROR_ENGINE, () =>
		delegate.execute(
			"c1",
			{ agent: "worker", task: "probe live note" },
			undefined,
			(u) => updates.push(u),
			{ sessionManager: { getSessionId: () => "sess-fallback" } },
		),
	);

	assert.match(
		String(updates[0]?.content?.[0]?.text ?? ""),
		/▶ worker · running/,
		"the start update is unchanged",
	);
	const live = updates.map((u) => String(u.content?.[0]?.text ?? "")).join("\n");
	assert.match(
		live,
		/↻ zai\/glm-5\.3 produced no work \(429 rate limited\) — falling back to zai\/glm-5\.3-flash/,
		"a mid-run update carries the fallback note",
	);
	assert.match(
		live,
		/\(working · turns 1 · 10→20 tok\)/,
		"the empty snapshot renders the moving progress line",
	);
	const text = String(result.content?.[0]?.text ?? "");
	assert.match(
		text,
		/↻ zai\/glm-5\.3 produced no work \(429 rate limited\)/,
		"durable note trails the result text",
	);
	const fallbacks = result.details?.fallbacks;
	assert.ok(
		Array.isArray(fallbacks) && fallbacks.length === 1,
		"details.fallbacks carries the event",
	);
	assert.equal(fallbacks[0].from, "zai/glm-5.3");
	assert.equal(fallbacks[0].to, "zai/glm-5.3-flash");
	assert.equal(fallbacks[0].lastError, "429 rate limited");
	assert.ok(
		customs.some((m) => m.customType === "torus.delegation-result"),
		"result marker emitted",
	);
	registry.setCustomSender(() => {});
});
