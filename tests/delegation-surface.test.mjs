import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	await withEngine(EVENT_ENGINE, async () => {
		await delegate.execute(
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
});
