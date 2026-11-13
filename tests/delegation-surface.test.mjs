import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// TORUS_HOME must land before the registry import — it derives the logs dir at
// module load. The fake engines let delegation runs execute without a live
// engine: rpc attempts die on close (no protocol), and the JSON fallback
// consumes whatever the script prints on stdout.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-delegation-surface-test-"));
process.env.TORUS_HOME = HOME;

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fake-engines-"));
const SILENT_ENGINE = path.join(ENGINE_DIR, "silent-engine.sh");
const EVENT_ENGINE = path.join(ENGINE_DIR, "event-engine.sh");
writeFileSync(SILENT_ENGINE, "#!/bin/sh\nexit 0\n", "utf8");
writeFileSync(
	EVENT_ENGINE,
	'#!/bin/sh\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(SILENT_ENGINE, 0o755);
chmodSync(EVENT_ENGINE, 0o755);
// Sleeps 1s when the prompt argv carries "slow stagger" so a two-run fan-out
// settles its runs far past any test-shrunk coalesce window.
const STAGGER_ENGINE = path.join(ENGINE_DIR, "stagger-engine.sh");
writeFileSync(
	STAGGER_ENGINE,
	'#!/bin/sh\ncase "$*" in *"slow stagger"*) sleep 1 ;; esac\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(STAGGER_ENGINE, 0o755);
// Emits the full usage shape the pinned engine produces: cache counters plus
// the computed cost object (models with catalog pricing).
const COST_ENGINE = path.join(ENGINE_DIR, "cost-engine.sh");
writeFileSync(
	COST_ENGINE,
	'#!/bin/sh\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"cacheRead":900,"cacheWrite":100,"cost":{"input":0.01,"output":0.02,"cacheRead":0.001,"cacheWrite":0.0005,"total":0.0315}}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(COST_ENGINE, 0o755);
// Verbatim message_end usage captured from a live zai/glm-5.3-flash RPC child
// (RPC and JSON modes stream the same record shape). The extra reasoning and
// totalTokens fields are load-bearing fixture detail: they pin the real wire
// shape so a fold that mis-reads it fails here, not in production.
const LIVE_USAGE =
	'{"input":12081,"output":18,"cacheRead":0,"cacheWrite":0,"reasoning":15,"totalTokens":12099,"cost":{"input":0.00181215,"output":0.000009,"cacheRead":0,"cacheWrite":0,"total":0.00182115}}';
const LIVE_RPC_ENGINE = path.join(ENGINE_DIR, "live-rpc-engine.sh");
writeFileSync(
	LIVE_RPC_ENGINE,
	`#!/bin/sh\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":${LIVE_USAGE}}}'\nexit 0\n`,
	"utf8",
);
chmodSync(LIVE_RPC_ENGINE, 0o755);
// message_end with no usage object at all: zero tokens, zero cost — the one
// live shape that must render a turn line with no dollar segment.
const NO_USAGE_ENGINE = path.join(ENGINE_DIR, "no-usage-engine.sh");
writeFileSync(
	NO_USAGE_ENGINE,
	'#!/bin/sh\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"bare"}]}}\'\nexit 0\n',
	"utf8",
);
chmodSync(NO_USAGE_ENGINE, 0o755);
// Mirrors a live reviewer run whose model connection died mid-verdict: the
// last message_end turn replays byte-identical cumulative usage
// (13084/2050 tok · $0.0428) and byte-identical partial text AND carries the
// engine's first-class failure signal (stopReason "error" + errorMessage),
// then the child exits 0 — a clean exit over a dead, errored tail.
const DEGENERATE_TAIL_ENGINE = path.join(ENGINE_DIR, "degenerate-tail-engine.sh");
writeFileSync(
	DEGENERATE_TAIL_ENGINE,
	[
		"#!/bin/sh",
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading the tasklist and mailboxes first."}],"usage":{"input":12000,"output":2000,"cost":{"total":0.04}}}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Let me check TEAMS_ROOT resolution, then run the acceptance suite."}],"usage":{"input":1084,"output":50,"cost":{"total":0.0028}}}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Let me check TEAMS_ROOT resolution, then run the acceptance suite."}],"usage":{"input":0,"output":0,"cost":{"total":0}},"stopReason":"error","errorMessage":"fetch failed"}}\'',
		"exit 0",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(DEGENERATE_TAIL_ENGINE, 0o755);
// The silent twin: same dead tail, but the engine emitted no error markers at
// all — the shape only the no-progress heuristic net can catch.
const SILENT_TAIL_ENGINE = path.join(ENGINE_DIR, "silent-tail-engine.sh");
writeFileSync(
	SILENT_TAIL_ENGINE,
	[
		"#!/bin/sh",
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading the tasklist and mailboxes first."}],"usage":{"input":12000,"output":2000,"cost":{"total":0.04}}}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Let me check TEAMS_ROOT resolution, then run the acceptance suite."}],"usage":{"input":1084,"output":50,"cost":{"total":0.0028}}}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Let me check TEAMS_ROOT resolution, then run the acceptance suite."}],"usage":{"input":0,"output":0,"cost":{"total":0}}}}\'',
		"exit 0",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(SILENT_TAIL_ENGINE, 0o755);
// The final turn carries stopReason "error" + errorMessage but still makes
// progress (fresh text + token delta), so the heuristic tail stays at 0 — the
// engine's error signal alone must gate this run red.
const MODEL_ERROR_ENGINE = path.join(ENGINE_DIR, "model-error-engine.sh");
writeFileSync(
	MODEL_ERROR_ENGINE,
	[
		"#!/bin/sh",
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading the tasklist first."}],"usage":{"input":12000,"output":2000,"cost":{"total":0.04}},"stopReason":"toolUse"}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"The verdict was cut off mid-sentence."}],"usage":{"input":300,"output":60,"cost":{"total":0.001}},"stopReason":"error","errorMessage":"fetch failed"}}\'',
		"exit 0",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(MODEL_ERROR_ENGINE, 0o755);
// A chain walk: the zai leg does two real turns then stalls into a no-progress
// tail (rejected), the opencode-go leg does three clean turns (accepted). The
// models are told apart by the --model argv so both legs share one script.
const WALK_ENGINE = path.join(ENGINE_DIR, "walk-engine.sh");
writeFileSync(
	WALK_ENGINE,
	[
		"#!/bin/sh",
		'case "$*" in',
		'  *"--model zai"*)',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"zai turn1"}],"usage":{"input":12000,"output":2000,"cost":{"total":0.04}},"stopReason":"toolUse"}}\'',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"zai turn2"}],"usage":{"input":1200,"output":200,"cost":{"total":0.004}},"stopReason":"toolUse"}}\'',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"zai turn2"}],"usage":{"input":0,"output":0,"cost":{"total":0}}}}\'',
		"    exit 0 ;;",
		'  *"--model opencode-go"*)',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"oc turn1"}],"usage":{"input":100,"output":50,"cost":{"total":0.01}},"stopReason":"toolUse"}}\'',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"oc turn2"}],"usage":{"input":80,"output":40,"cost":{"total":0.008}},"stopReason":"toolUse"}}\'',
		'    echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"oc final answer"}],"usage":{"input":70,"output":30,"cost":{"total":0.006}},"stopReason":"stop"}}\'',
		"    exit 0 ;;",
		"esac",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(WALK_ENGINE, 0o755);
// The engine retried a transient failure and gave up: auto_retry_end with
// success:false + finalError — the "week of connection errors" shape.
const AUTO_RETRY_FAIL_ENGINE = path.join(ENGINE_DIR, "auto-retry-fail-engine.sh");
writeFileSync(
	AUTO_RETRY_FAIL_ENGINE,
	[
		"#!/bin/sh",
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading the tasklist first."}],"usage":{"input":12000,"output":2000,"cost":{"total":0.04}},"stopReason":"stop"}}\'',
		'echo \'{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"}\'',
		'echo \'{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"529 overloaded"}\'',
		"exit 0",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(AUTO_RETRY_FAIL_ENGINE, 0o755);
// Same shape, but the final turn makes progress (new text + token delta) —
// the healthy control for the dead-tail engine above.
const HEALTHY_TAIL_ENGINE = path.join(ENGINE_DIR, "healthy-tail-engine.sh");
writeFileSync(
	HEALTHY_TAIL_ENGINE,
	[
		"#!/bin/sh",
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading the tasklist and mailboxes first."}],"usage":{"input":12000,"output":2000,"cost":{"total":0.04}}}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Let me check TEAMS_ROOT resolution, then run the acceptance suite."}],"usage":{"input":1084,"output":50,"cost":{"total":0.0028}}}}\'',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Verdict: the acceptance suite passes; shipping."}],"usage":{"input":200,"output":80,"cost":{"total":0.0009}}}}\'',
		"exit 0",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(HEALTHY_TAIL_ENGINE, 0o755);
// One engine, two behaviors: a task whose text carries "fail me" exits 1
// (runDelegation reports that shape as ok:false with a text/exit headline),
// every other task completes the healthy message_end. One binary lets a
// single fan-out batch mix failed and successful runs.
const MIXED_ENGINE = path.join(ENGINE_DIR, "mixed-engine.sh");
writeFileSync(
	MIXED_ENGINE,
	[
		"#!/bin/sh",
		'case "$*" in *"fail me"*) echo "engine exploded" >&2; exit 1 ;; esac',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'',
		"exit 0",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(MIXED_ENGINE, 0o755);

// RPC attempts exit immediately (no protocol handshake); the JSON fallback
// emits one turn, then hangs — a run with progress that stays "running"
// until the operator stop kills it: the fleet-view x path under test.
const HANG_ENGINE = path.join(ENGINE_DIR, "hang-engine.sh");
writeFileSync(
	HANG_ENGINE,
	[
		"#!/bin/sh",
		'case "$*" in *"--mode rpc"*) exit 0 ;; esac',
		'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"steady"}],"usage":{"input":10,"output":20}}}\'',
		"exec sleep 10",
		"",
	].join("\n"),
	"utf8",
);
chmodSync(HANG_ENGINE, 0o755);

const registry = await import("../extensions/registry.ts");
const { childSessionsRoot } = await import("../extensions/fsutil.ts");
const roster = await import("../extensions/roster/index.ts");
const team = await import("../extensions/team/index.ts");
const ui = await import("../extensions/ui/index.ts");

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;

// Built-in chain providers are credential-gated at resolution: dummy env
// values (presence only — nothing reads them) keep chain resolution hermetic
// instead of depending on the machine's real ~/.pi/agent/auth.json.
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
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

// Dead attempts enter the session's no-work cooldown; clear it between tests
// so each starts from the unfiltered chain.
beforeEach(() => roster.resetFailureMemoForTesting());

function captureCustoms(spy) {
	registry.setCustomSender((message) => spy.push(message));
}

async function withEngine(bin, fn) {
	process.env.TORUS_ENGINE_BIN = bin;
	try {
		return await fn();
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}
}

test("crashed delegation emits a failure torus.delegation-result before rethrowing", async (t) => {
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("chmod-based write failures do not apply to root");
		return;
	}
	registry.resetRegistryForTesting();
	const customs = [];
	let sabotaged = null;
	registry.setCustomSender((message) => {
		customs.push(message);
		if (message.customType === "torus.delegation-start") {
			// The start marker fires right before the engine loop: sabotage the
			// delegation log here so the next registry write (the rpc-unavailable
			// action line) throws into runDelegation's crash path.
			const running = registry.listDelegations().find((r) => r.status === "running");
			assert.ok(running, "start marker emitted before the registry record exists");
			sabotaged = running.logFile;
			chmodSync(sabotaged, 0o000);
		}
	});

	await withEngine(SILENT_ENGINE, async () => {
		await assert.rejects(
			roster.runDelegation("builder", "crash probe", undefined, undefined, "sess-crash", "boom"),
			/EACCES/,
		);
	});

	const started = customs.find((m) => m.customType === "torus.delegation-start");
	assert.ok(started, "start marker must be emitted");
	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1, "crash path must emit exactly one result marker");
	const failure = results[0];
	assert.equal(failure.display, true);
	assert.deepEqual(failure.content, [{ type: "text", text: "builder failed" }]);
	const details = failure.details ?? {};
	assert.equal(details.agent, "builder");
	assert.equal(details.ok, false);
	assert.equal(details.delegationId, started.details.delegationId);
	assert.equal(details.handle, "boom");
	assert.equal(typeof details.durationMs, "number");
	assert.match(String(details.error), /EACCES/);
	assert.equal(
		registry.listDelegations().find((r) => r.id === details.delegationId)?.status,
		"failed",
		"registry record must be marked failed even though its log write threw",
	);
	if (sabotaged) chmodSync(sabotaged, 0o600);
	registry.setCustomSender(() => {});
});

test("successful delegation surfaces its delegationId and finished marker", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);

	await withEngine(EVENT_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"builder",
			"ok probe",
			undefined,
			undefined,
			"sess-ok",
			"fine",
		);
		assert.equal(outcome.ok, true);
		assert.match(outcome.delegationId, /^[0-9a-f-]{36}$/);
		assert.equal(
			registry.listDelegations().find((r) => r.id === outcome.delegationId)?.status,
			"done",
		);
	});

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].content, [{ type: "text", text: "builder finished" }]);
	assert.equal(results[0].details.ok, true);

	const bareLog = readFileSync(registry.listDelegations().at(-1).logFile, "utf8");
	assert.match(
		bareLog,
		/--- turn 1 \(10\/20 tok · \$0\) ---/,
		"engine usage without a cost field renders an explicit $0",
	);
	assert.doesNotMatch(bareLog, /NaN/, "no NaN for unpriced runs");
	assert.doesNotMatch(
		bareLog,
		/retrying down-chain/,
		"a healthy settled run accepts at the chain head without a retry",
	);
	registry.setCustomSender(() => {});
});

test("delegation stopped from the fleet view reports interrupted, never retries down-chain", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);

	await withEngine(HANG_ENGINE, async () => {
		const run = roster.runDelegation(
			"builder",
			"hang probe",
			undefined,
			undefined,
			"sess-stop",
			"stoppable",
			null,
			false,
		);
		let record;
		for (let i = 0; i < 500 && record === undefined; i++) {
			record = registry.listDelegations().find((r) => r.status === "running" && r.turns >= 1);
			if (record === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(record, "delegation never reached a running first turn");
		assert.equal(registry.stopDelegation(record.id), true);

		const outcome = await run;
		assert.equal(outcome.ok, false);
		assert.equal(outcome.details.stopped, true, "outcome must carry the stop, not a bare failure");
		assert.match(outcome.text, /interrupted — stopped from the fleet view/);
		const log = readFileSync(record.logFile, "utf8");
		assert.match(log, /<torus:stop-requested /);
		assert.ok(!log.includes("retrying down-chain"), "cancelled run respawned down-chain");
	});

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].content, [{ type: "text", text: "builder stopped" }]);
	assert.equal(results[0].details.stopped, true);
	assert.equal(results[0].details.ok, false);
	assert.equal(registry.listDelegations().find((r) => r.handle === "stoppable")?.status, "failed");
	registry.setCustomSender(() => {});
});

test("delegation ending in an engine-signaled model error fails red with the error text surfaced", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);

	await withEngine(DEGENERATE_TAIL_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"reviewer",
			"review the acceptance suite",
			undefined,
			undefined,
			"sess-degenerate",
			"dead-tail",
		);
		assert.equal(outcome.ok, false, "clean exit with an errored tail must fail, not render green");
		assert.equal(
			outcome.details.exitCode,
			0,
			"the engine finalized cleanly — the failure is the error signal",
		);
		// Three rejected legs, three turns each: the walk's cumulative spend.
		assert.equal(outcome.details.turns, 9);
		assert.equal(
			outcome.details.model,
			"opencode-go/glm-5.3-flash",
			"a settled exit over a dead tail walks down-chain to the last candidate",
		);
		assert.equal(
			outcome.details.error,
			"fetch failed",
			"the engine's errorMessage is the surfaced failure text",
		);
		assert.equal(outcome.details.noProgressTail, 1, "the dead turn also trips the heuristic net");
		const keys = Object.keys(outcome.details);
		assert.ok(
			keys.indexOf("error") < keys.indexOf("noProgress"),
			"the real error renders before the heuristic note",
		);
		assert.match(
			outcome.text,
			/Let me check TEAMS_ROOT resolution, then run the acceptance suite\./,
			"partial text is preserved as the result text",
		);
	});

	const record = registry.listDelegations().at(-1);
	assert.ok(record, "registry record exists for the errored run");
	assert.equal(record.status, "failed", "errored run must be marked failed in the registry");
	const log = readFileSync(record.logFile, "utf8");
	assert.match(
		log,
		/produced no work \(exit 0\) — retrying down-chain/,
		"settling is not proof of work: a zero exit over a dead tail retries down-chain",
	);
	assert.match(log, /falling back to zai\/glm-5\.3-flash/, "the walk names the next candidate");
	assert.match(log, /--- turn 2 \(13084\/2050 tok · \$0\.0428\) ---/);
	assert.match(
		log,
		/--- turn 3 \(13084\/2050 tok · \$0\.0428\) ---/,
		"the log mirrors the observed pattern: identical cumulative turn lines",
	);

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].content, [{ type: "text", text: "reviewer failed" }]);
	assert.equal(results[0].details.ok, false, "result marker must carry ok:false");
	assert.equal(
		results[0].details.error,
		"fetch failed",
		"marker details carry the engine error text",
	);
	assert.equal(results[0].details.noProgressTail, 1, "marker details expose the dead tail");
	registry.setCustomSender(() => {});
});

test("a progressing error turn fails on the engine signal alone, not the heuristic", async () => {
	registry.resetRegistryForTesting();
	let outcome = null;
	await withEngine(MODEL_ERROR_ENGINE, async () => {
		outcome = await roster.runDelegation(
			"reviewer",
			"review it",
			undefined,
			undefined,
			"sess-model-error",
			"err",
		);
	});
	assert.equal(
		outcome.ok,
		false,
		"stopReason error fails the run even though every turn progressed",
	);
	assert.equal(outcome.details.error, "fetch failed");
	assert.equal(
		outcome.details.noProgressTail,
		0,
		"the heuristic saw progress — the engine signal did the gating, not the heuristic",
	);
	assert.equal(outcome.details.noProgress, undefined, "no heuristic note when the tail is clean");
});

test("a silent dead tail with no engine error still fails through the heuristic net", async () => {
	registry.resetRegistryForTesting();
	let outcome = null;
	await withEngine(SILENT_TAIL_ENGINE, async () => {
		outcome = await roster.runDelegation(
			"reviewer",
			"review it",
			undefined,
			undefined,
			"sess-silent-tail",
			"quiet",
		);
	});
	assert.equal(
		outcome.ok,
		false,
		"the engine signaled nothing — only the heuristic catches the dead tail",
	);
	assert.equal(outcome.details.error, undefined, "no engine error text to surface");
	assert.equal(outcome.details.noProgressTail, 1);
	assert.match(
		outcome.details.noProgress,
		/delegated run ended without model progress \(1 turn\(s\) with no progress — connection or model failure\)/,
	);
	assert.equal(outcome.details.exitCode, 0, "the silent shape still exits cleanly");
});

test("auto-retry exhaustion fails the run with the engine's finalError", async () => {
	registry.resetRegistryForTesting();
	let outcome = null;
	await withEngine(AUTO_RETRY_FAIL_ENGINE, async () => {
		outcome = await roster.runDelegation(
			"builder",
			"build it",
			undefined,
			undefined,
			"sess-retry",
			"flaky",
		);
	});
	assert.equal(outcome.ok, false, "auto_retry_end success:false is a failed run");
	assert.equal(
		outcome.details.error,
		"529 overloaded",
		"the engine's finalError is the surfaced text",
	);
	assert.equal(
		outcome.details.noProgressTail,
		0,
		"the heuristic tail is clean — the retry signal gated",
	);
	assert.equal(outcome.details.noProgress, undefined);
});

test("delegate tool block renders red for a model-error run and stays green for healthy runs", async () => {
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
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ctx = {
		ui: { setStatus: () => {} },
		sessionManager: { getSessionId: () => "sess-render" },
	};

	let dead = null;
	await withEngine(DEGENERATE_TAIL_ENGINE, async () => {
		dead = await delegate.execute(
			"c1",
			{ agent: "reviewer", task: "review it" },
			undefined,
			undefined,
			ctx,
		);
	});
	assert.equal(dead.isError, true, "exit-0 model error must flag isError so the block renders red");
	assert.equal(dead.details.error, "fetch failed", "the tool block carries the engine error text");
	assert.match(dead.content[0].text, /Let me check TEAMS_ROOT resolution/, "partial text kept");
	assert.equal(dead.structuredContent, undefined, "no structuredContent for a failed run");
	const red = delegate
		.renderResult(dead, { expanded: false, isPartial: false }, theme, { isError: true })
		.render(200)
		.join("\n");
	assert.match(red, /failed/, "model-error run renders the failed status");
	assert.doesNotMatch(red, /done/, "model-error run must not render the green done status");

	let healthy = null;
	await withEngine(HEALTHY_TAIL_ENGINE, async () => {
		healthy = await delegate.execute(
			"c2",
			{ agent: "reviewer", task: "review it" },
			undefined,
			undefined,
			ctx,
		);
	});
	assert.equal(healthy.isError, undefined, "healthy multi-turn run is not an error");
	assert.equal(healthy.details.noProgressTail, 0, "healthy run carries a clean tail");
	assert.equal(healthy.structuredContent.ok, true);
	const green = delegate
		.renderResult(healthy, { expanded: false, isPartial: false }, theme, { isError: false })
		.render(200)
		.join("\n");
	assert.match(green, /done/, "healthy run still renders green");
	registry.setCustomSender(() => {});
});

test("announceText: true previews the task, false suppresses, string passes through", () => {
	assert.equal(roster.announceText(false, "task text"), null);
	assert.equal(roster.announceText(true, "task text"), "task text");
	assert.equal(roster.announceText(true, "x".repeat(500)).length, 400);
	assert.equal(roster.announceText("neutral note", "task text"), "neutral note");
});

test("string announce replaces the task preview in the start marker", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);

	await withEngine(EVENT_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"builder",
			"You are reflecting on a just-idled torus session: distill its activity into durable memory.",
			undefined,
			undefined,
			"sess-announce",
			"quiet",
			null,
			"background reflection started — dreamer handles it, no action needed",
		);
		assert.equal(outcome.ok, true);
	});

	const started = customs.find((m) => m.customType === "torus.delegation-start");
	assert.ok(started, "start marker must be emitted");
	assert.deepEqual(started.content, [
		{ type: "text", text: "background reflection started — dreamer handles it, no action needed" },
	]);
	assert.ok(
		!JSON.stringify(started).includes("You are reflecting"),
		"task text must not leak into the start marker",
	);
	registry.setCustomSender(() => {});
});

test("pre-flight rejection carries no delegationId and emits no markers", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);
	const outcome = await roster.runDelegation("no-such-agent", "probe");
	assert.equal(outcome.ok, false);
	assert.equal(outcome.delegationId, null);
	assert.deepEqual(customs, [], "no run started, so no start/result markers");
	registry.setCustomSender(() => {});
});

test("session_start docks chips, then the fleet strip, then a blank-row gap", () => {
	const handlers = {};
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getMcpServers: () => [],
		getActiveTools: () => [],
		// quietStartup skips the startup-banner install (setHeader surface);
		// this test only pins the above-editor dock order
		getSettings: () => ({ quietStartup: true }),
	};
	ui.registerUi(fakePi);
	const registered = [];
	const ctx = {
		mode: "tui",
		ui: {
			setWidget: (key, factory) => registered.push([key, factory]),
			theme: { fg: (_color, text) => text, bold: (text) => `*${text}*` },
		},
	};
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(
		registered.map(([key]) => key),
		["torus-statusline", "torus-fleet", "torus-dock-gap", "torus:cursor-blink"],
		"docked rows render in registration order; the gap must be the last row " +
			"before the editor so it spaces the whole dock off the input box",
	);
	const gap = registered.find(([key]) => key === "torus-dock-gap")?.[1]?.({}, {});
	assert.deepEqual(gap.render(140), [""], "the gap paints exactly one blank row");
});

test("pi-lsp footer status is absorbed into the main segment, right after mcp", () => {
	const handlers = {};
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getMcpServers: () => [],
		getActiveTools: () => [],
		getSettings: () => ({ quietStartup: true }),
	};
	ui.registerUi(fakePi);
	ui.torusChips().delete("torus");
	const forwarded = [];
	const uiSurface = {
		setStatus: (key, text) => forwarded.push([key, text]),
		setWidget: () => {},
		theme: { fg: (_color, text) => text, bold: (text) => `*${text}*` },
	};
	const ctx = { mode: "tui", ui: uiSurface };
	handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
	assert.notEqual(uiSurface.setStatus, forwarded.push.bind(forwarded));

	uiSurface.setStatus("pi-lsp", "\u001b[32mLSP 2\u001b[0m");
	const main = ui.torusChips().get("torus") ?? "";
	assert.ok(main.includes("lsp:2"), "the wrap repaints the main segment through the captured ctx");
	assert.ok(
		main.replaceAll("\u001b", "").includes("[32mlsp:2[0m"),
		"the count is restyled in place, SGR colors survive verbatim",
	);
	assert.deepEqual(forwarded.at(-1), ["pi-lsp", undefined], "the footer slot stays clear");

	ui.setStatusExtras({ connected: 2, registered: 2 }, null);
	uiSurface.setStatus("pi-lsp", "LSP 2 init 1");
	const order = ui.buildStatus();
	assert.ok(
		order.indexOf("mcp:2") < order.indexOf("lsp:2 init 1"),
		"lsp renders inside the main segment right after the mcp count",
	);
	assert.ok(!order.includes("LSP "), "transient parts keep their wording, the count does not");

	uiSurface.setStatus("other", "git main");
	assert.deepEqual(forwarded.at(-1), ["other", "git main"], "foreign keys pass through untouched");

	uiSurface.setStatus("pi-lsp", undefined);
	assert.ok(!ui.buildStatus().includes("lsp:"), "clearing the status clears the segment");
	ui.setStatusExtras(null, null);

	handlers["session_start"]({ type: "session_start", reason: "resume" }, ctx);
	forwarded.length = 0;
	uiSurface.setStatus("other", "x");
	assert.equal(forwarded.length, 1, "a re-fired session_start does not stack wrappers");
});

function registeredTools() {
	const tools = [];
	team.registerTeam({
		registerTool: (tool) => tools.push(tool),
	});
	return tools;
}

test("fanout paints no per-run statusline chips (live state rides the fleet strip)", async () => {
	registry.resetRegistryForTesting();
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	const statuses = [];
	const ctx = {
		sessionManager: { getSessionId: () => "sess-fanout" },
		ui: { setStatus: (key, value) => statuses.push([key, value]) },
	};

	await withEngine(EVENT_ENGINE, async () => {
		const result = await fanoutTool.execute(
			"call-1",
			{
				runs: [
					{ agent: "builder", task: "a", handle: "alpha" },
					{ agent: "builder", task: "b", handle: "beta" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.ok, 2);
	});

	assert.equal(
		statuses.filter(([key]) => /^torus:(alpha|beta)/.test(key)).length,
		0,
		"no per-run chip keys painted for the batch",
	);
});

test("chain paints no per-step statusline chips", async () => {
	registry.resetRegistryForTesting();
	const chainTool = registeredTools().find((t) => t.name === "torus_chain");
	assert.ok(chainTool, "torus_chain not registered");
	const statuses = [];
	const ctx = {
		sessionManager: { getSessionId: () => "sess-chain" },
		ui: { setStatus: (key, value) => statuses.push([key, value]) },
	};

	await withEngine(EVENT_ENGINE, async () => {
		const result = await chainTool.execute(
			"call-1",
			{
				steps: [
					{ agent: "builder", task: "s1", handle: "one" },
					{ agent: "builder", task: "s2", handle: "two" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.ok, 2);
	});

	assert.equal(
		statuses.filter(([key]) => /^torus:(one|two)/.test(key)).length,
		0,
		"no per-step chip keys painted",
	);
});

test("fan-out emits one combined start marker instead of per-run markers", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	const ctx = {
		sessionManager: { getSessionId: () => "sess-fanout-combined" },
		ui: { setStatus: () => {} },
	};

	await withEngine(EVENT_ENGINE, async () => {
		const result = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "probe a", handle: "alpha" },
					{ agent: "builder", task: "probe b", handle: "beta" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.ok, 2, "both runs succeed under the fake engine");
	});

	const starts = customs.filter((m) => m.customType === "torus.delegation-start");
	assert.equal(starts.length, 1, "exactly one combined start marker for the batch");
	assert.equal(starts[0].details.agent, "fan-out");
	assert.equal(starts[0].details.runs, 2);
	assert.match(starts[0].content[0].text, /^fan-out ×2: @alpha \(builder\), @beta \(builder\)$/);
	assert.ok(
		!starts.some((m) => typeof m.details.delegationId === "string"),
		"no per-run start markers may leak",
	);
	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 1, "simultaneous completions flush as one combined marker");
	assert.equal(results[0].details.agent, "fan-out");
	assert.equal(results[0].details.handle, undefined, "combined marker carries no handle");
	assert.equal(results[0].details.runs, 2);
	assert.match(
		results[0].content[0].text,
		/^fan-out (@alpha ✓, @beta ✓|@beta ✓, @alpha ✓)$/,
		"combined marker lists runs in completion order",
	);
	registry.setCustomSender(() => {});
});

test("fan-out staggered completions flush per-run markers carrying the bare handle", async () => {
	registry.resetRegistryForTesting();
	const customs = [];
	captureCustoms(customs);
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	const ctx = {
		sessionManager: { getSessionId: () => "sess-fanout-staggered" },
		ui: { setStatus: () => {} },
	};

	// Shrink the coalesce window so the 1s-staggered second completion misses it
	// and flushes as its own single-run marker (the user-visible "finished" line).
	team.setFanoutCoalesceForTesting(150);
	try {
		await withEngine(STAGGER_ENGINE, async () => {
			const result = await fanoutTool.execute(
				"call",
				{
					runs: [
						{ agent: "builder", task: "fast stagger probe", handle: "alpha" },
						{ agent: "builder", task: "slow stagger probe", handle: "beta" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			assert.equal(result.details.ok, 2, "both runs succeed under the fake engine");
		});
	} finally {
		team.setFanoutCoalesceForTesting(5_000);
	}
	// The last single-run flush rides a 150ms timer that outlives execute().
	await new Promise((resolve) => setTimeout(resolve, 400));

	const results = customs.filter((m) => m.customType === "torus.delegation-result");
	assert.equal(results.length, 2, "completions past the coalesce window flush separately");
	assert.deepEqual(
		results.map((m) => m.details.handle).sort(),
		["alpha", "beta"],
		"each single-run marker carries its run's bare handle",
	);
	for (const marker of results) {
		assert.ok(
			!marker.details.handle.startsWith("@"),
			"handles must be bare — the notify renderer prepends the @",
		);
		assert.equal(marker.details.agent, "builder");
		assert.equal(marker.details.runs, 1);
	}
	registry.setCustomSender(() => {});
});

test("fan-out flags isError so failed runs render red; healthy batches stay green", async () => {
	registry.resetRegistryForTesting();
	registry.setCustomSender(() => {});
	const fanoutTool = registeredTools().find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	const ctx = {
		sessionManager: { getSessionId: () => "sess-fanout-red" },
		ui: { setStatus: () => {} },
	};

	let allFailed = null;
	let mixed = null;
	let healthy = null;
	await withEngine(MIXED_ENGINE, async () => {
		allFailed = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "fail me a", handle: "dead1" },
					{ agent: "builder", task: "fail me b", handle: "dead2" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		mixed = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "succeed a", handle: "alive" },
					{ agent: "builder", task: "fail me b", handle: "dead" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		healthy = await fanoutTool.execute(
			"call",
			{
				runs: [
					{ agent: "builder", task: "succeed a", handle: "alpha" },
					{ agent: "builder", task: "succeed b", handle: "beta" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
	});
	assert.equal(allFailed.isError, true, "a batch where every run failed must render red");
	assert.equal(allFailed.details.ok, 0);
	assert.match(allFailed.content[0].text, /0\/2 ok/, "headline carries the ok count");
	assert.match(allFailed.content[0].text, /## builder — failed/);
	assert.equal(mixed.isError, true, "one failed run still flags the whole batch red");
	assert.equal(mixed.details.ok, 1);
	assert.match(mixed.content[0].text, /1\/2 ok/);
	assert.match(mixed.content[0].text, /exit=1/, "the failed run's exit code stays visible in text");
	assert.equal(healthy.isError, undefined, "a fully successful batch is not an error");
	assert.equal(healthy.details.ok, 2);
	assert.doesNotMatch(healthy.content[0].text, /ok\n/);
});

test("chain flags isError when a step fails and stays green when every step passes", async () => {
	registry.resetRegistryForTesting();
	registry.setCustomSender(() => {});
	const chainTool = registeredTools().find((t) => t.name === "torus_chain");
	assert.ok(chainTool, "torus_chain not registered");
	const ctx = {
		sessionManager: { getSessionId: () => "sess-chain-red" },
		ui: { setStatus: () => {} },
	};

	let broken = null;
	let healthy = null;
	await withEngine(MIXED_ENGINE, async () => {
		broken = await chainTool.execute(
			"call",
			{
				steps: [
					{ agent: "reviewer", task: "fail me now" },
					{ agent: "builder", task: "build it" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		healthy = await chainTool.execute(
			"call",
			{
				steps: [
					{ agent: "reviewer", task: "review it" },
					{ agent: "builder", task: "build it" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
	});
	assert.equal(broken.isError, true, "a chain whose step failed must render red");
	assert.equal(broken.details.steps, 1, "the chain stops at the failed step");
	assert.equal(broken.details.ok, 0);
	assert.match(broken.content[0].text, /stopped after 0 of 2 steps/);
	assert.equal(healthy.isError, undefined);
	assert.equal(healthy.details.ok, 2);
});

test("delegation markers defer to the turn boundary and snapshots carry the run id", async () => {
	registry.resetRegistryForTesting();
	const sent = [];
	registry.setCustomSender((message, options) => sent.push({ message, options }));
	const snapshots = [];

	await withEngine(EVENT_ENGINE, async () => {
		await roster.runDelegation(
			"builder",
			"opts probe",
			undefined,
			(s) => snapshots.push(s),
			"sess-opts",
		);
	});

	const start = sent.find((e) => e.message.customType === "torus.delegation-start");
	const result = sent.find((e) => e.message.customType === "torus.delegation-result");
	assert.ok(start && result, "start and result markers both emitted");
	assert.equal(
		start.options?.triggerTurn,
		false,
		"start marker defers instead of steering mid-run",
	);
	assert.equal(
		result.options?.triggerTurn,
		false,
		"result marker defers instead of steering mid-run",
	);
	assert.ok(
		snapshots.length > 0 && typeof snapshots[0].delegationId === "string",
		"onTurn snapshots carry the delegation id",
	);
	registry.setCustomSender(() => {});
});

test("delegate leads with a live start signal before the first child turn", async () => {
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
	const paints = [];
	const customs = [];
	captureCustoms(customs);
	let outcome = null;

	await withEngine(EVENT_ENGINE, async () => {
		outcome = await delegate.execute(
			"c1",
			{ agent: "builder", task: "live probe", handle: "scout" },
			undefined,
			(u) => updates.push(u),
			{
				ui: { setStatus: (k, v) => paints.push([k, v]) },
				sessionManager: { getSessionId: () => "sess-live" },
			},
		);
	});

	assert.match(
		String(updates[0]?.content?.[0]?.text ?? ""),
		/▶ @scout · running/,
		"immediate onUpdate leads the delegation",
	);
	assert.equal(paints.length, 0, "no per-run statusline chips for tool-driven delegate");
	assert.ok(
		!customs.some((m) => m.customType === "torus.delegation-start"),
		"no start marker for tool-driven delegate — the tool block is the surface",
	);
	assert.ok(
		customs.some((m) => m.customType === "torus.delegation-result"),
		"result marker still emitted on completion",
	);
	assert.equal(typeof outcome?.details?.turns, "number", "result details carry the turn count");
	assert.equal(
		outcome?.details?.turns,
		outcome?.details?.usage?.turns,
		"top-level turns matches usage.turns",
	);
	assert.equal(typeof outcome?.details?.delegationId, "string", "result details carry the run id");
	registry.setCustomSender(() => {});
});

test("delegate tool block renders turns and is mouse-clickable", () => {
	const tools = [];
	roster.registerRoster({
		registerTool: (t) => tools.push(t),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	});
	const delegate = tools.find((t) => t.name === "torus_delegate");
	assert.ok(delegate, "torus_delegate not registered");
	const theme = { fg: (_color, text) => text, bold: (text) => text };

	const call = delegate.renderCall(
		{ agent: "reviewer", task: "probe", handle: "plan-review" },
		theme,
	);
	assert.equal(typeof call.handleMouse, "function", "call line is a mouse region");

	const usage = { input: 35850, output: 13234, turns: 7 };
	const result = delegate.renderResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				agent: "reviewer",
				model: "zai/glm-5.3",
				exitCode: 0,
				delegationId: "run-1",
				turns: usage.turns,
				usage,
			},
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	const headline = result.render(200).join("\n");
	assert.match(headline, /7 turns/, "turn count rendered");
	assert.doesNotMatch(headline, /\? turns/, "no placeholder turn count");
	assert.equal(typeof result.handleMouse, "function", "result line is a mouse region");

	const usageOnlyDetails = {
		content: [{ type: "text", text: "done" }],
		details: {
			agent: "reviewer",
			model: "zai/glm-5.3",
			exitCode: 0,
			usage: { input: 1, output: 2, turns: 3 },
		},
	};
	const usageOnly = delegate.renderResult(
		usageOnlyDetails,
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.match(
		usageOnly.render(200)[0],
		/3 turns/,
		"turns fall back to usage when top-level is absent",
	);
});

test("engine-computed cache and cost ride the delegation pipeline end to end", async () => {
	registry.resetRegistryForTesting();
	const snapshots = [];

	await withEngine(COST_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"builder",
			"cost probe",
			undefined,
			(snapshot) => snapshots.push(snapshot),
			"sess-cost",
			"priced",
		);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.usage.cacheRead, 900, "result usage carries cacheRead");
		assert.equal(outcome.details.usage.cacheWrite, 100, "result usage carries cacheWrite");
		assert.equal(outcome.details.usage.cost, 0.0315, "result usage carries the engine cost total");
	});

	assert.ok(snapshots.length > 0, "cost engine produced at least one turn snapshot");
	const snap = snapshots.at(-1);
	assert.equal(snap.usage.input, 10, "snapshot round-trip keeps input tokens");
	assert.equal(snap.usage.cacheRead, 900, "snapshot round-trip keeps cacheRead");
	assert.equal(snap.usage.cacheWrite, 100, "snapshot round-trip keeps cacheWrite");
	assert.equal(snap.usage.cost, 0.0315, "snapshot round-trip keeps cost");

	const record = registry.listDelegations().at(-1);
	assert.ok(record, "registry record exists for the run");
	assert.equal(record.cacheRead, 900, "registry record stores cacheRead");
	assert.equal(record.cacheWrite, 100, "registry record stores cacheWrite");
	assert.equal(record.cost, 0.0315, "registry record stores cost");
	const log = readFileSync(record.logFile, "utf8");
	assert.match(
		log,
		/--- turn 1 \(10\/20 tok · \$0\.0315\) ---/,
		"delegation log turn line carries the dollar segment",
	);
	registry.setCustomSender(() => {});
});

test("orphaned running delegations reconcile from their child transcript", async () => {
	registry.resetRegistryForTesting();
	roster._drivenDelegationsForTesting().clear();
	// a run the current module instance does not drive (a /reload orphaned it)
	// with two completed turns in its child session transcript
	await registry.startDelegation("orphan-1", "builder", "m", "sess-orphan", null);
	registry.attachSessionId("orphan-1", "child-sess-orphan-1");
	const transcriptDir = childSessionsRoot();
	mkdirSync(transcriptDir, { recursive: true });
	const turn = (text, total) =>
		JSON.stringify({
			type: "message",
			id: `m-${text}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 10, output: 5, cost: { total } },
				stopReason: "stop",
			},
		});
	writeFileSync(
		path.join(transcriptDir, "child-sess-orphan-1.jsonl"),
		`${turn("first", 0.03)}\n${turn("second", 0)}\n`,
		"utf8",
	);

	await roster.reconcileOrphanedDelegations();
	let record = registry.listDelegations().find((r) => r.id === "orphan-1");
	assert.equal(record.turns, 2, "orphan folds its transcript turns");
	assert.equal(record.tokensIn, 20, "orphan folds its transcript tokens");
	assert.equal(record.cost, 0.03, "orphan folds its transcript cost");

	// a no-change pass appends nothing to the delegation log
	const log = readFileSync(record.logFile, "utf8");
	await roster.reconcileOrphanedDelegations();
	record = registry.listDelegations().find((r) => r.id === "orphan-1");
	assert.equal(
		readFileSync(record.logFile, "utf8"),
		log,
		"no-change pass writes no duplicate turn line",
	);

	// driven records are left to their live driver
	await registry.startDelegation("driven-1", "builder", "m", "sess-orphan", null);
	registry.attachSessionId("driven-1", "child-sess-orphan-1");
	roster._drivenDelegationsForTesting().add("driven-1");
	await roster.reconcileOrphanedDelegations();
	const driven = registry.listDelegations().find((r) => r.id === "driven-1");
	assert.equal(driven.cost, 0, "driven records are not reconciled");

	roster._drivenDelegationsForTesting().clear();
	registry.resetRegistryForTesting();
});

test("a chain walk's snapshots and result carry cumulative spend across legs", async () => {
	registry.resetRegistryForTesting();
	const snapshots = [];

	await withEngine(WALK_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"explorer",
			"walk probe",
			undefined,
			(snapshot) => snapshots.push(snapshot),
			"sess-walk",
		);
		assert.equal(outcome.ok, true);
		assert.equal(
			outcome.details.turns,
			6,
			"turns sum across the rejected leg and the accepted one",
		);
		assert.equal(outcome.details.usage.input, 13450, "input tokens sum across legs");
		assert.equal(outcome.details.usage.output, 2320, "output tokens sum across legs");
		assert.equal(outcome.details.usage.cost, 0.068, "cost sums across legs");
		assert.equal(outcome.details.usage.turns, 6, "usage.turns matches the top-level count");
	});

	// The zai leg counts 1..3; the opencode-go leg continues at 4 — the fallback
	// resets the model, never the visible counter (strip and record both read
	// these snapshots).
	const ocFirst = snapshots.filter((s) => s.text === "oc turn1");
	assert.ok(ocFirst.length > 0, "the accepted leg streamed snapshots");
	assert.ok(
		ocFirst.every((s) => s.turns === 4),
		"the second leg's first turn continues the walk's count",
	);
	assert.equal(snapshots.at(-1).turns, 6, "the final snapshot carries the walk total");

	const record = registry.listDelegations().at(-1);
	assert.equal(record.turns, 6, "the registry record holds the walk total");
	assert.equal(record.cost, 0.068, "the registry record folds every leg's cost");
	assert.match(
		readFileSync(record.logFile, "utf8"),
		/--- turn 6 \(13450\/2320 tok · \$0\.0680\) ---/,
		"the log's last turn line is the cumulative walk total",
	);
	registry.setCustomSender(() => {});
});

test("orphan reconciliation folds every chain-walk leg's transcript", async () => {
	registry.resetRegistryForTesting();
	roster._drivenDelegationsForTesting().clear();
	await registry.startDelegation("orphan-legs", "builder", "m", "sess-legs", null);
	registry.attachSessionId("orphan-legs", "child-sess-leg1");
	registry.attachSessionId("orphan-legs", "child-sess-leg2");
	const transcriptDir = childSessionsRoot();
	mkdirSync(transcriptDir, { recursive: true });
	const turn = (text, input, output, total) =>
		JSON.stringify({
			type: "message",
			id: `m-${text}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input, output, cost: { total } },
				stopReason: "stop",
			},
		});
	writeFileSync(
		path.join(transcriptDir, "child-sess-leg1.jsonl"),
		`${turn("leg1a", 10, 5, 0.03)}\n${turn("leg1b", 10, 5, 0)}\n`,
		"utf8",
	);
	writeFileSync(
		path.join(transcriptDir, "child-sess-leg2.jsonl"),
		`${turn("leg2a", 20, 10, 0.02)}\n`,
		"utf8",
	);

	await roster.reconcileOrphanedDelegations();
	const record = registry.listDelegations().find((r) => r.id === "orphan-legs");
	assert.equal(record.turns, 3, "the fold sums both legs' turns");
	assert.equal(record.tokensIn, 40, "the fold sums both legs' input tokens");
	assert.equal(record.tokensOut, 20, "the fold sums both legs' output tokens");
	assert.equal(record.cost, 0.05, "the fold sums both legs' cost");
	assert.equal(record.text, "leg2a", "the text is the last leg's");

	roster._drivenDelegationsForTesting().clear();
	registry.resetRegistryForTesting();
});

/** Spawn a process that exits immediately and return its (now dead) pid. */
async function exitedPid() {
	const child = spawn(process.execPath, ["-e", ""]);
	await new Promise((resolve) => child.on("close", resolve));
	return child.pid;
}

test("orphaned delegations terminalize when their recorded child pid is dead", async () => {
	registry.resetRegistryForTesting();
	roster._drivenDelegationsForTesting().clear();
	const transcriptDir = childSessionsRoot();
	mkdirSync(transcriptDir, { recursive: true });
	const turn = (text, total) =>
		JSON.stringify({
			type: "message",
			id: `m-${text}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 10, output: 5, cost: { total } },
				stopReason: "stop",
			},
		});

	// dead child: spend folds, then the record terminalizes failed with an end tag
	const dead = await exitedPid();
	await registry.startDelegation("orphan-dead", "builder", "m", "sess-o2", null);
	registry.attachSessionId("orphan-dead", "child-sess-o2");
	registry.attachChildPid("orphan-dead", dead);
	writeFileSync(
		path.join(transcriptDir, "child-sess-o2.jsonl"),
		`${turn("first", 0.03)}\n`,
		"utf8",
	);
	await roster.reconcileOrphanedDelegations();
	let deadRecord = registry.listDelegations().find((r) => r.id === "orphan-dead");
	assert.equal(deadRecord.status, "failed", "dead child terminalizes as failed");
	assert.equal(deadRecord.turns, 1, "spend folds before the finalize");
	assert.match(deadRecord.text, /\[orphaned: .*child pid \d+ .*finalized from its transcript\]/);
	assert.match(
		readFileSync(deadRecord.logFile, "utf8"),
		/<torus:failed /,
		"end tag lands in the log",
	);
	await roster.reconcileOrphanedDelegations();
	deadRecord = registry.listDelegations().find((r) => r.id === "orphan-dead");
	assert.equal(
		readFileSync(deadRecord.logFile, "utf8").match(/<torus:failed /g)?.length,
		1,
		"a terminalized record is skipped on later passes",
	);

	// live child: spend folds, record truthfully stays running
	await registry.startDelegation("orphan-live", "builder", "m", "sess-o2", null);
	registry.attachSessionId("orphan-live", "child-sess-o3");
	registry.attachChildPid("orphan-live", process.pid);
	writeFileSync(
		path.join(transcriptDir, "child-sess-o3.jsonl"),
		`${turn("first", 0.03)}\n${turn("second", 0)}\n`,
		"utf8",
	);
	await roster.reconcileOrphanedDelegations();
	const liveRecord = registry.listDelegations().find((r) => r.id === "orphan-live");
	assert.equal(liveRecord.status, "running", "live child keeps the record running");
	assert.equal(liveRecord.turns, 2, "live child spend still folds");

	roster._drivenDelegationsForTesting().clear();
	registry.resetRegistryForTesting();
});

test("attachControl persists child pid and session tags in the delegation log", async () => {
	registry.resetRegistryForTesting();
	await registry.startDelegation("tags-1", "builder", "m", null, null);
	registry.attachControl("tags-1", { stop: () => {}, steer: () => false, pid: 4242 });
	const record = registry.listDelegations().find((r) => r.id === "tags-1");
	assert.equal(record.childPid, 4242);
	assert.match(readFileSync(record.logFile, "utf8"), /<torus:pid pid="4242"/);
	registry.attachSessionId("tags-1", "sess-tags-1");
	assert.match(readFileSync(record.logFile, "utf8"), /<torus:session id="sess-tags-1"/);

	// same-pid re-attach and a repeat session attach write no duplicate tags
	registry.attachControl("tags-1", { stop: () => {}, steer: () => false, pid: 4242 });
	registry.attachSessionId("tags-1", "sess-tags-1");
	const log = readFileSync(record.logFile, "utf8");
	assert.equal(log.match(/<torus:pid /g)?.length, 1);
	assert.equal(log.match(/<torus:session /g)?.length, 1);

	// a respawned child (chain-walk fallback) replaces the pid with a second tag
	registry.attachControl("tags-1", { stop: () => {}, steer: () => false, pid: 4243 });
	assert.equal(record.childPid, 4243);
	assert.equal(readFileSync(record.logFile, "utf8").match(/<torus:pid /g)?.length, 2);

	// a respawned child's session replaces the live one and appends its tag:
	// the record follows the leg doing work, the log keeps every leg
	registry.attachSessionId("tags-1", "sess-tags-leg2");
	assert.equal(
		registry.listDelegations().find((r) => r.id === "tags-1").sessionId,
		"sess-tags-leg2",
	);
	const legLog = readFileSync(record.logFile, "utf8");
	assert.equal(legLog.match(/<torus:session /g)?.length, 2);
	assert.match(legLog, /<torus:session id="sess-tags-leg2"/);
	registry.resetRegistryForTesting();
});

test("rehydrate: un-ended runs with a dead child read failed, live ones stay running", async () => {
	registry.resetRegistryForTesting();
	const dead = await exitedPid();
	await registry.startDelegation("rehy-dead", "builder", "m", "sess-rehy", null);
	registry.attachSessionId("rehy-dead", "child-rehy-dead");
	registry.attachChildPid("rehy-dead", dead);
	registry.updateDelegation("rehy-dead", {
		text: "partial work",
		turns: 1,
		usage: { input: 10, output: 5 },
	});
	await registry.startDelegation("rehy-live", "builder", "m", "sess-rehy", null);
	registry.attachSessionId("rehy-live", "child-rehy-live");
	registry.attachChildPid("rehy-live", process.pid);
	registry.updateDelegation("rehy-live", {
		text: "still going",
		turns: 1,
		usage: { input: 7, output: 3 },
	});

	registry.resetRegistryForTesting();
	registry.rehydrateFromLogs("sess-rehy");
	const records = registry.listDelegations();
	const deadRec = records.find((r) => r.id.includes("rehy-dead"));
	const liveRec = records.find((r) => r.id.includes("rehy-live"));
	assert.ok(deadRec && liveRec, "both un-ended logs rehydrate");
	assert.equal(deadRec.status, "failed", "dead child reads failed");
	assert.equal(deadRec.sessionId, "child-rehy-dead", "session tag recovers the child session");
	assert.equal(deadRec.childPid, dead);
	assert.equal(liveRec.status, "running", "live child reads running");
	assert.equal(liveRec.sessionId, "child-rehy-live");
	registry.resetRegistryForTesting();
});

test("rehydrate: a chain walk's session tags recover the last leg", async () => {
	registry.resetRegistryForTesting();
	await registry.startDelegation("rehy-legs", "builder", "m", "sess-rehy", null);
	const record = registry.listDelegations().find((r) => r.id === "rehy-legs");
	registry.attachSessionId("rehy-legs", "child-leg-1");
	registry.attachSessionId("rehy-legs", "child-leg-2");
	const log = readFileSync(record.logFile, "utf8");
	assert.equal(log.match(/<torus:session /g)?.length, 2);

	registry.resetRegistryForTesting();
	registry.rehydrateFromLogs("sess-rehy");
	const recovered = registry.listDelegations().find((r) => r.id.includes("rehy-legs"));
	assert.equal(recovered.sessionId, "child-leg-2", "the last leg wins");
	registry.resetRegistryForTesting();
});

test("session replacement retires the registry; reload keeps it", async () => {
	registry.resetRegistryForTesting();

	// The registry is process-shared and survives pi's extension rebind on a
	// session switch, so the outgoing session's records are exactly what a
	// /resume inherits unless shutdown drops them.
	await registry.startDelegation("replaced-run", "builder", "m", "sess-old", "old-handle");
	await registry.finishDelegation("replaced-run", true, "old session output", null);
	await registry.startDelegation("incoming-run", "builder", "m", "sess-incoming", null);
	await registry.finishDelegation("incoming-run", true, "incoming session output", null);

	await registry.registryShutdown("reload");
	assert.equal(
		registry.listDelegations().find((r) => r.id === "replaced-run")?.text,
		"old session output",
		"reload keeps the session's records",
	);

	await registry.registryShutdown("resume");
	assert.equal(
		registry.listDelegations().length,
		0,
		"replacement must drop the outgoing session's records",
	);

	registry.rehydrateFromLogs("sess-incoming");
	const rehydrated = registry.listDelegations();
	assert.equal(
		rehydrated.find((r) => r.id.includes("incoming-run"))?.parentSession,
		"sess-incoming",
		"the incoming session's own logs rehydrate once the registry is clear",
	);
	assert.ok(
		!rehydrated.some((r) => r.id.includes("replaced-run")),
		"the outgoing session's runs must not leak into the new session",
	);
	registry.resetRegistryForTesting();
});

test("live-captured RPC usage shape folds cost into snapshots, records, and log lines", async () => {
	registry.resetRegistryForTesting();
	const snapshots = [];

	await withEngine(LIVE_RPC_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"explorer",
			"Reply with the single word ok",
			undefined,
			(snapshot) => snapshots.push(snapshot),
			"sess-live",
			"live-capture",
		);
		assert.equal(outcome.ok, true);
		assert.equal(
			outcome.details.usage.cost,
			0.00182115,
			"cost.total from the live wire shape lands in result usage",
		);
		assert.equal(outcome.details.usage.input, 12081, "live input tokens folded");
	});

	const snap = snapshots.at(-1);
	assert.ok(snap, "live-shape engine produced a turn snapshot");
	assert.equal(snap.usage.cost, 0.00182115, "snapshot carries the live cost total");

	const record = registry.listDelegations().at(-1);
	assert.ok(record, "registry record exists for the live-shape run");
	assert.equal(record.cost, 0.00182115, "registry record stores the live cost total");
	const log = readFileSync(record.logFile, "utf8");
	assert.match(
		log,
		/--- turn 1 \(12081\/18 tok · \$0\.0018\) ---/,
		"turn line from the captured wire shape ends with the dollar segment",
	);
	assert.doesNotMatch(log, /NaN/, "no NaN anywhere in the log");
	registry.setCustomSender(() => {});
});

test("message_end without a usage object writes a dollar-free turn line", async () => {
	registry.resetRegistryForTesting();

	await withEngine(NO_USAGE_ENGINE, async () => {
		const outcome = await roster.runDelegation(
			"explorer",
			"bare probe",
			undefined,
			undefined,
			"sess-bare",
		);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.usage.input, 0, "no usage object folds zero input tokens");
		assert.equal(outcome.details.usage.cost, 0, "no usage object folds zero cost");
	});

	const log = readFileSync(registry.listDelegations().at(-1).logFile, "utf8");
	assert.match(
		log,
		/--- turn 1 \(0\/0 tok\) ---/,
		"zero-token turn line carries no dollar segment",
	);
	assert.doesNotMatch(log, /\$|NaN/, "no dollar segment and no NaN without usage");
	registry.setCustomSender(() => {});
});

test("delegate headline renders the dollar segment for priced, free, and unpriced runs", () => {
	const tools = [];
	roster.registerRoster({
		registerTool: (t) => tools.push(t),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	});
	const delegate = tools.find((t) => t.name === "torus_delegate");
	assert.ok(delegate, "torus_delegate not registered");
	const theme = { fg: (_color, text) => text, bold: (text) => text };

	const render = (usage) =>
		delegate
			.renderResult(
				{
					content: [{ type: "text", text: "done" }],
					details: { agent: "reviewer", model: "zai/glm-5.3", exitCode: 0, turns: 2, usage },
				},
				{ expanded: false, isPartial: false },
				theme,
			)
			.render(200)
			.join("\n");

	assert.match(
		render({ input: 1000, output: 500, turns: 2, cost: 0.0123 }),
		/1000\/500 tok · \$0\.0123/,
		"sub-dollar cost keeps 4 decimal places",
	);
	assert.match(
		render({ input: 1000, output: 500, turns: 2, cost: 1.234 }),
		/· \$1\.23/,
		"cost at or above $1 trims to 2 decimal places",
	);
	assert.match(
		render({ input: 1000, output: 500, turns: 2, cost: 0 }),
		/1000\/500 tok · \$0/,
		"tokens spent with no catalog price renders an explicit $0",
	);
	const unpriced = render({ input: 1000, output: 500, turns: 2 });
	assert.doesNotMatch(unpriced, /\$/, "absent cost renders no dollar segment");
	assert.match(unpriced, /1000\/500 tok/, "token segment renders when cost is absent");
});

// Structured-output checks: pi-ai exports Type but no Value, so validate
// structuredContent against the tool's real outputSchema (plain JSON Schema)
// with a hand-rolled checker, plus a permissiveness walk (optional fields,
// no additionalProperties bans).
function schemaError(schema, value, at = "value") {
	if (schema.anyOf) {
		return schema.anyOf.some((s) => schemaError(s, value, at) === null)
			? null
			: `${at}: matches no union member`;
	}
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return `${at}: expected object`;
		for (const key of schema.required ?? []) {
			if (!(key in value)) return `${at}.${key}: required`;
		}
		for (const [key, prop] of Object.entries(schema.properties ?? {})) {
			if (!(key in value)) continue;
			const err = schemaError(prop, value[key], `${at}.${key}`);
			if (err) return err;
		}
		return null;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return `${at}: expected array`;
		for (const [i, item] of value.entries()) {
			const err = schemaError(schema.items, item, `${at}[${i}]`);
			if (err) return err;
		}
		return null;
	}
	if (schema.type === "string") return typeof value === "string" ? null : `${at}: expected string`;
	if (schema.type === "number") return typeof value === "number" ? null : `${at}: expected number`;
	if (schema.type === "boolean")
		return typeof value === "boolean" ? null : `${at}: expected boolean`;
	if (schema.type === "null") return value === null ? null : `${at}: expected null`;
	return `${at}: unsupported schema type ${String(schema.type)}`;
}

function assertPermissive(schema, at = "schema") {
	if (schema.anyOf) {
		for (const member of schema.anyOf) assertPermissive(member, at);
		return;
	}
	if (schema.type === "array") {
		assertPermissive(schema.items, `${at}[]`);
		return;
	}
	if (schema.type !== "object" || !schema.properties) return;
	assert.notEqual(schema.additionalProperties, false, `${at} must not ban additional properties`);
	const required = new Set(schema.required ?? []);
	for (const [key, prop] of Object.entries(schema.properties)) {
		assert.ok(!required.has(key), `${at}.${key} must be optional`);
		assertPermissive(prop, `${at}.${key}`);
	}
}

function assertStructured(tool, structured) {
	assert.ok(tool.outputSchema, `${tool.name} must declare outputSchema`);
	const err = schemaError(tool.outputSchema, structured);
	assert.ok(err === null, `${tool.name} structuredContent fails outputSchema: ${err}`);
}

test("delegate carries structuredContent on success and omits it on failure", async () => {
	registry.resetRegistryForTesting();
	const registered = [];
	roster.registerRoster({
		registerTool: (t) => registered.push(t),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => {},
	});
	const delegate = registered.find((t) => t.name === "torus_delegate");
	assert.ok(delegate, "torus_delegate not registered");
	assertPermissive(delegate.outputSchema);

	let success = null;
	await withEngine(EVENT_ENGINE, async () => {
		success = await delegate.execute(
			"c1",
			{ agent: "builder", task: "structured probe" },
			undefined,
			undefined,
			{
				ui: { setStatus: () => {} },
				sessionManager: { getSessionId: () => "sess-structured" },
			},
		);
	});
	assert.ok(success?.structuredContent, "success result carries structuredContent");
	const sc = success.structuredContent;
	assert.equal(sc.ok, true);
	assert.equal(sc.text, success.content[0].text, "structured text mirrors the content block");
	assert.equal(sc.delegationId, success.details.delegationId);
	assert.equal(sc.model, success.details.model);
	assert.equal(sc.turns, success.details.turns);
	assert.deepEqual(sc.usage, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 });
	assertStructured(delegate, sc);

	const failure = await delegate.execute(
		"c2",
		{ agent: "no-such-agent", task: "probe" },
		undefined,
		undefined,
		{
			ui: { setStatus: () => {} },
			sessionManager: { getSessionId: () => "sess-structured" },
		},
	);
	assert.equal(failure.isError, undefined, "unknown-agent surfaces through text, not isError");
	assert.equal(
		failure.structuredContent,
		undefined,
		"unknown-agent failure must omit structuredContent",
	);
	assert.match(failure.content[0].text, /Unknown agent/);
	registry.setCustomSender(() => {});
});
