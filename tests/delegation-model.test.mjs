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

// Per-run model overrides for delegations: torus_delegate/fanout/chain accept a
// `model` (chain shorthands or exact id), validated pre-flight, steering the
// chain walk; agent frontmatter `model:` pins the agent's own delegations.
//
// The roster loads agents/ from repoRoot() at module load, so a fixture root
// with two agents (one primary-chain worker with --tools, one pinning flash on
// a primary chain) rides in via TORUS_ROOT. TORUS_HOME must land before the
// registry import — it derives the logs dir at module load. The fake engine
// writes one file per spawn with its argv (one arg per line) so tests assert
// the exact spawn contract (--model <id> before --tools); rpc attempts die on
// close (no protocol), the JSON fallback consumes the emitted event and the
// run succeeds on the first attempted model.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-delegation-model-test-"));
process.env.TORUS_HOME = HOME;

const ROOT = mkdtempSync(path.join(tmpdir(), "torus-model-fixture-root-"));
const FIXTURE_AGENTS = path.join(ROOT, "agents");
mkdirSync(FIXTURE_AGENTS, { recursive: true });
writeFileSync(
	path.join(FIXTURE_AGENTS, "worker.md"),
	[
		"---",
		"name: worker",
		"description: Fixture chain-primary worker with a tools allowlist",
		"chain: primary",
		"tools: read, grep",
		"---",
		"",
		"Fixture worker body.",
		"",
	].join("\n"),
	"utf8",
);
writeFileSync(
	path.join(FIXTURE_AGENTS, "pinned.md"),
	[
		"---",
		"name: pinned",
		"description: Fixture agent pinning flash on a primary chain",
		"chain: primary",
		"model: zai/glm-5.3-flash",
		"---",
		"",
		"Fixture pinned body.",
		"",
	].join("\n"),
	"utf8",
);
process.env.TORUS_ROOT = ROOT;

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-fake-engines-"));
const ARGS_ENGINE = path.join(ENGINE_DIR, "args-engine.sh");
writeFileSync(
	ARGS_ENGINE,
	'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TORUS_ARGS_DIR/spawn-$$.txt"\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(ARGS_ENGINE, 0o755);

const registry = await import("../extensions/registry.ts");
const roster = await import("../extensions/roster/index.ts");
const team = await import("../extensions/team/index.ts");

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;

after(() => {
	process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

// Fresh argv dir per test so spawn counts are exact.
function freshArgsDir(name) {
	const dir = path.join(ENGINE_DIR, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	process.env.TORUS_ARGS_DIR = dir;
	return dir;
}

async function withEngine(fn) {
	process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;
	try {
		return await fn();
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}
}

/** All spawn argv batches so far: one array of args per engine invocation. */
function spawnBatches(dir) {
	return readdirSync(dir)
		.filter((f) => f.startsWith("spawn-"))
		.map((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean));
}

/** True when some spawn carried `--model <id>` positioned before `--tools`. */
function spawnedOnModelBeforeTools(batches, id) {
	return batches.some((args) => {
		const model = args.indexOf("--model");
		const tools = args.indexOf("--tools");
		return model !== -1 && args[model + 1] === id && tools !== -1 && model < tools;
	});
}

test("model 'fast' spawns on the fast head with --model before --tools", async () => {
	registry.resetRegistryForTesting();
	const dir = freshArgsDir("fast-override");
	registry.setCustomSender(() => {});

	await withEngine(async () => {
		const outcome = await roster.runDelegation(
			"worker",
			"probe fast",
			undefined,
			undefined,
			null,
			"fast-run",
			null,
			undefined,
			undefined,
			{ model: "fast" },
		);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.model, "zai/glm-5.3-flash");
	});

	const batches = spawnBatches(dir);
	assert.ok(batches.length > 0, "engine must have been spawned");
	assert.ok(
		spawnedOnModelBeforeTools(batches, "zai/glm-5.3-flash"),
		"--model zai/glm-5.3-flash must precede --tools in spawn args",
	);
	assert.ok(
		!spawnedOnModelBeforeTools(batches, "zai/glm-5.3"),
		"primary head must not have been attempted",
	);
});

test("shorthand 'primary' resolves to the concrete chain head", async () => {
	registry.resetRegistryForTesting();
	const dir = freshArgsDir("primary-shorthand");
	registry.setCustomSender(() => {});

	await withEngine(async () => {
		const outcome = await roster.runDelegation(
			"worker",
			"probe primary",
			undefined,
			undefined,
			null,
			null,
			null,
			undefined,
			undefined,
			{ model: "primary" },
		);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.model, "zai/glm-5.3");
		const record = registry.listDelegations().find((r) => r.id === outcome.delegationId);
		assert.equal(record?.model, "zai/glm-5.3", "registry record carries the resolved id");
	});

	assert.ok(
		spawnedOnModelBeforeTools(spawnBatches(dir), "zai/glm-5.3"),
		"spawn must lead with the resolved primary head",
	);
});

test("invalid model rejects pre-flight naming candidates, with zero spawns", async () => {
	registry.resetRegistryForTesting();
	freshArgsDir("invalid");
	const customs = [];
	registry.setCustomSender((message) => customs.push(message));

	const outcome = await roster.runDelegation(
		"worker",
		"probe bad",
		undefined,
		undefined,
		null,
		null,
		null,
		undefined,
		undefined,
		{ model: "gpt-99" },
	);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.delegationId, null);
	assert.match(outcome.text, /Invalid model "gpt-99"/);
	for (const candidate of ["primary", "fast", "zai/glm-5.3", "zai/glm-5.3-flash"]) {
		assert.ok(outcome.text.includes(candidate), `error must name candidate ${candidate}`);
	}
	assert.equal(
		readdirSync(process.env.TORUS_ARGS_DIR).length,
		0,
		"invalid model must not spawn the engine",
	);
	assert.deepEqual(customs, [], "no run started, so no start/result markers");
	registry.setCustomSender(() => {});
});

test("frontmatter model pins the agent's delegations over its chain head", async () => {
	registry.resetRegistryForTesting();
	const dir = freshArgsDir("frontmatter-pin");
	registry.setCustomSender(() => {});

	await withEngine(async () => {
		const outcome = await roster.runDelegation("pinned", "probe pin");
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.model, "zai/glm-5.3-flash");
		const record = registry.listDelegations().find((r) => r.id === outcome.delegationId);
		assert.equal(record?.model, "zai/glm-5.3-flash");
	});

	const batches = spawnBatches(dir);
	assert.ok(batches.length > 0);
	assert.ok(
		batches.every((args) => args[args.indexOf("--model") + 1] === "zai/glm-5.3-flash"),
		"every attempt of the pinned agent must run on flash, never the primary head",
	);
});

test("fan-out runs mix per-run models across one batch", async () => {
	registry.resetRegistryForTesting();
	const dir = freshArgsDir("fanout-mix");
	registry.setCustomSender(() => {});
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	const fanoutTool = tools.find((t) => t.name === "torus_fanout");
	assert.ok(fanoutTool, "torus_fanout not registered");
	const ctx = {
		sessionManager: { getSessionId: () => "sess-model-mix" },
		ui: { setStatus: () => {} },
	};

	await withEngine(async () => {
		const result = await fanoutTool.execute(
			"call-model-mix",
			{
				runs: [
					{ agent: "worker", task: "run a", handle: "alpha", model: "fast" },
					{ agent: "worker", task: "run b", handle: "beta", model: "primary" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.ok, 2, "both runs succeed under the fake engine");
	});

	const batches = spawnBatches(dir);
	assert.ok(
		spawnedOnModelBeforeTools(batches, "zai/glm-5.3-flash"),
		"run A must spawn on the fast head",
	);
	assert.ok(
		spawnedOnModelBeforeTools(batches, "zai/glm-5.3"),
		"run B must spawn on the primary head",
	);
});
