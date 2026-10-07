import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

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

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");
const team = await import("../extensions/team/index.ts");
const ui = await import("../extensions/ui/index.ts");

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;

after(() => {
	process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

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
		assert.equal(outcome.details.turns, 3);
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

test("statusline chip counts delegate, fanout, and chain executions", () => {
	const handlers = {};
	const fakePi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getMcpServers: () => [],
		getActiveTools: () => [],
	};
	ui.registerUi(fakePi);
	const paints = [];
	const ctx = {
		ui: {
			setStatus: (key, value) => paints.push([key, value]),
			theme: { fg: (_color, text) => text, bold: (text) => `*${text}*` },
		},
	};
	const start = (toolName) => handlers["tool_execution_start"]({ toolName }, ctx);
	const end = (toolName) => handlers["tool_execution_end"]({ toolName }, ctx);

	assert.ok(!ui.buildStatus().includes("delegate"), "baseline: no chip");
	start("torus_delegate");
	start("torus_fanout");
	start("torus_chain");
	assert.ok(ui.buildStatus().includes("delegate ×3"), "all three delegation tools count");
	end("torus_fanout");
	assert.ok(ui.buildStatus().includes("delegate ×2"), "fanout end decrements");
	end("torus_delegate");
	end("torus_chain");
	assert.ok(!ui.buildStatus().includes("delegate"), "chip clears when all finish");
	assert.ok(paints.length >= 4, "each transition repaints the torus status key");
});

function registeredTools() {
	const tools = [];
	team.registerTeam({
		registerTool: (tool) => tools.push(tool),
	});
	return tools;
}

test("fanout paints a per-run statusline turn marker for every parallel run", async () => {
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

	for (const handle of ["alpha", "beta"]) {
		assert.ok(
			statuses.some(
				([key, value]) =>
					key === `torus:${handle}` && String(value).includes(`▶ @${handle} · starting`),
			),
			`@${handle} starting chip painted before the first snapshot`,
		);
		assert.ok(
			statuses.some(
				([key, value]) =>
					new RegExp(`^torus:${handle}:[0-9a-f]{8}$`).test(key) &&
					String(value).includes(`▶ @${handle} · turn 1 · 20 tok`),
			),
			`@${handle} turn marker painted on its id-suffixed key`,
		);
	}
	assert.equal(
		statuses.filter(([key, value]) => /torus:(alpha|beta)/.test(key) && value === undefined).length,
		4,
		"each run clears its base and suffixed marker on completion",
	);
});

test("chain paints a per-step statusline turn marker and clears it per step", async () => {
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

	for (const handle of ["one", "two"]) {
		assert.ok(
			statuses.some(
				([key, value]) =>
					new RegExp(`^torus:${handle}:[0-9a-f]{8}$`).test(key) &&
					String(value).includes(`▶ @${handle} · turn 1 · 20 tok`),
			),
			`@${handle} turn marker painted on its id-suffixed key`,
		);
		assert.ok(
			statuses.some(
				([key, value]) =>
					new RegExp(`^torus:${handle}(:[0-9a-f]{8})?$`).test(key) && value === undefined,
			),
			`@${handle} marker must be cleared after the step`,
		);
	}
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
	assert.ok(
		paints.some(([k, v]) => k === "torus:scout" && String(v).includes("starting")),
		"starting chip painted before the first snapshot",
	);
	assert.ok(
		paints.some(([k]) => /^torus:scout:[0-9a-f]{8}$/.test(k)),
		"turn chip keyed by delegation id",
	);
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

	const legacyDetails = {
		content: [{ type: "text", text: "done" }],
		details: {
			agent: "reviewer",
			model: "zai/glm-5.3",
			exitCode: 0,
			usage: { input: 1, output: 2, turns: 3 },
		},
	};
	const legacy = delegate.renderResult(legacyDetails, { expanded: false, isPartial: false }, theme);
	assert.match(
		legacy.render(200)[0],
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
