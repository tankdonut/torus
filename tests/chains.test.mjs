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

// User-configurable model chains: `chains.json` under TORUS_HOME overrides the
// built-in MODEL_CHAINS per tier. A tier counts only as a non-empty array of
// non-empty ids; absent/empty/malformed tiers fall back to that tier's default
// (mixed validity allowed), and a file that is not JSON warns on stderr while
// both chains stay default. Overrides ride the same provider-availability
// filter as the defaults, and agent frontmatter `model:` still wins.
//
// The same file's `providers` map registers compatible endpoints (Ollama,
// OpenRouter, …) via pi.registerProvider: each valid entry becomes one call
// with its models mapped to full chat configs; an invalid entry warns on
// stderr naming the provider and is SKIPPED, never failing the rest.
//
// TORUS_HOME and TORUS_ROOT must land before the registry/roster imports (the
// registry derives its logs dir and the roster loads agents/ at module load).
// The fake engine writes one file per spawn with its argv so the happy path
// asserts the override reaches the child's `--model`.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-chains-test-"));
process.env.TORUS_HOME = HOME;

const ROOT = mkdtempSync(path.join(tmpdir(), "torus-chains-fixture-root-"));
const FIXTURE_AGENTS = path.join(ROOT, "agents");
mkdirSync(FIXTURE_AGENTS, { recursive: true });
writeFileSync(
	path.join(FIXTURE_AGENTS, "worker.md"),
	[
		"---",
		"name: worker",
		"description: Fixture chain-primary worker",
		"chain: primary",
		"tools: read",
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
		"description: Fixture agent pinning a model over its chain head",
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

// Deterministic defaults: without this, an ambient opencode-go credential set
// would add the gateway entries to the "no override" expectations below.
const PREV_OCGO_KEY = process.env.TORUS_OCGO_API_KEY;
const PREV_OCGO_URL = process.env.TORUS_OCGO_BASE_URL;
delete process.env.TORUS_OCGO_API_KEY;
delete process.env.TORUS_OCGO_BASE_URL;

const ENGINE_DIR = mkdtempSync(path.join(tmpdir(), "torus-chains-fake-engines-"));
const ARGS_ENGINE = path.join(ENGINE_DIR, "args-engine.sh");
writeFileSync(
	ARGS_ENGINE,
	'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TORUS_ARGS_DIR/spawn-$$.txt"\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20}}}\'\nexit 0\n',
	"utf8",
);
chmodSync(ARGS_ENGINE, 0o755);

const registry = await import("../extensions/registry.ts");
const providers = await import("../extensions/providers/index.ts");
const roster = await import("../extensions/roster/index.ts");
const sessionTitle = await import("../extensions/session-title/index.ts");

const CHAINS_JSON = path.join(HOME, "chains.json");
const DEFAULT_PRIMARY = ["zai/glm-5.3", "zai/glm-5.3-flash"];
const DEFAULT_FAST = ["zai/glm-5.3-flash"];

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;

after(() => {
	if (PREV_OCGO_KEY === undefined) delete process.env.TORUS_OCGO_API_KEY;
	else process.env.TORUS_OCGO_API_KEY = PREV_OCGO_KEY;
	if (PREV_OCGO_URL === undefined) delete process.env.TORUS_OCGO_BASE_URL;
	else process.env.TORUS_OCGO_BASE_URL = PREV_OCGO_URL;
	process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
});

function writeChains(data) {
	writeFileSync(CHAINS_JSON, JSON.stringify(data), "utf8");
}

function removeChains() {
	rmSync(CHAINS_JSON, { force: true });
}

/** Collect console.error lines emitted while `fn` runs (override warnings land there). */
function captureStderr(fn) {
	const lines = [];
	const original = console.error;
	console.error = (...args) => lines.push(args.map(String).join(" "));
	try {
		fn();
	} finally {
		console.error = original;
	}
	return lines;
}

test("no chains.json → built-in defaults, byte-identical", () => {
	removeChains();
	assert.deepEqual(roster.resolveModels("primary"), DEFAULT_PRIMARY);
	assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST);
	assert.equal(roster.personaModel("worker"), DEFAULT_PRIMARY[0]);
	assert.deepEqual(
		roster.availableModels(),
		["zai/glm-5.3", "zai/glm-5.3-flash"],
		"deduped union of both chains",
	);
});

test("valid override steers resolveModels and the chain head", () => {
	writeChains({ fast: ["zai/custom-model", "zai/second-choice"] });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/custom-model", "zai/second-choice"]);
	assert.deepEqual(roster.resolveModels("primary"), DEFAULT_PRIMARY, "primary stays default");
	assert.equal(roster.personaModel("worker"), DEFAULT_PRIMARY[0], "primary head unchanged");
	removeChains();
	assert.deepEqual(
		roster.resolveModels("fast"),
		DEFAULT_FAST,
		"default returns after the file is gone",
	);
});

test("overridden entries still ride the provider-availability filter", () => {
	writeChains({ fast: ["custom/provider-x", "zai/kept", "noproviderslash"] });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/kept"]);
	assert.equal(roster.personaModel("worker"), DEFAULT_PRIMARY[0]);
	removeChains();
});

test("malformed chains.json → defaults plus a stderr warning naming the file", () => {
	writeFileSync(CHAINS_JSON, "{not json at all", "utf8");
	let primary;
	let fast;
	const lines = captureStderr(() => {
		primary = roster.resolveModels("primary");
		fast = roster.resolveModels("fast");
	});
	assert.deepEqual(primary, DEFAULT_PRIMARY);
	assert.deepEqual(fast, DEFAULT_FAST);
	assert.ok(lines.length > 0, "a warning must reach stderr");
	assert.ok(
		lines.every((l) => l.includes(CHAINS_JSON)),
		"warning must name the file path",
	);
	removeChains();
});

test("empty tier falls back per-tier; the other tier still overrides", () => {
	writeChains({ primary: ["zai/p-custom"], fast: [] });
	assert.deepEqual(roster.resolveModels("primary"), ["zai/p-custom"], "valid tier overrides");
	assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST, "empty tier falls back");
	assert.equal(roster.personaModel("worker"), "zai/p-custom");
	removeChains();
});

test("mixed valid + malformed tiers: valid overrides, malformed falls back with a warning", () => {
	writeChains({ primary: ["zai/p-custom"], fast: "not-an-array" });
	let fast;
	const lines = captureStderr(() => {
		fast = roster.resolveModels("fast");
	});
	assert.deepEqual(roster.resolveModels("primary"), ["zai/p-custom"]);
	assert.deepEqual(fast, DEFAULT_FAST);
	assert.ok(
		lines.some((l) => l.includes(CHAINS_JSON) && l.includes("fast")),
		"warning must name the file and the tier",
	);
	removeChains();
});

test("tier with non-string entries is invalid as a whole", () => {
	writeChains({ fast: ["zai/ok", 42, null] });
	const lines = captureStderr(() => {
		assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST);
	});
	assert.ok(lines.some((l) => l.includes(CHAINS_JSON)));
	removeChains();
});

test("unknown tiers in the file are ignored", () => {
	writeChains({ turbo: ["zai/turbo"], fast: ["zai/custom-model"] });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/custom-model"]);
	removeChains();
});

const OLLAMA = {
	baseUrl: "http://127.0.0.1:11434/v1",
	api: "openai-completions",
	models: [{ id: "gemma3:12b", name: "Gemma 3 12B" }],
};

function registrationCalls() {
	const calls = [];
	return {
		calls,
		pi: { registerProvider: (name, config) => calls.push({ name, config }) },
	};
}

test("chains.json providers entry registers with the mapped provider config", () => {
	writeChains({ providers: { ollama: OLLAMA } });
	const { calls, pi } = registrationCalls();
	providers.registerProviders(pi);
	assert.equal(calls.length, 1, "exactly one registerProvider call");
	assert.equal(calls[0].name, "ollama");
	assert.equal(calls[0].config.baseUrl, "http://127.0.0.1:11434/v1");
	assert.equal(calls[0].config.api, "openai-completions");
	assert.equal(calls[0].config.apiKey, "ollama", "keyless local endpoint gets a dummy key");
	assert.deepEqual(calls[0].config.models, [
		{
			id: "gemma3:12b",
			name: "Gemma 3 12B",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
	]);
	removeChains();
});

test("declared provider + fast override: resolveModels keeps the local model id", () => {
	writeChains({ fast: ["ollama/gemma3:12b"], providers: { ollama: OLLAMA } });
	assert.deepEqual(roster.resolveModels("fast"), ["ollama/gemma3:12b"]);
	assert.ok(roster.availableModels().includes("ollama/gemma3:12b"));
	removeChains();
	assert.deepEqual(
		roster.resolveModels("fast"),
		DEFAULT_FAST,
		"default returns after the file is gone",
	);
});

for (const [label, entry] of [
	["missing baseUrl", { api: "openai-completions", models: [{ id: "gemma3:12b" }] }],
	["empty models", { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", models: [] }],
	[
		"unsupported api",
		{ baseUrl: "http://127.0.0.1:11434/v1", api: "grpc", models: [{ id: "gemma3:12b" }] },
	],
]) {
	test(`unregistrable provider entry (${label}) warns, skips, defaults hold`, () => {
		writeChains({ fast: ["ollama/gemma3:12b", "zai/kept"], providers: { ollama: entry } });
		const { calls, pi } = registrationCalls();
		const lines = captureStderr(() => providers.registerProviders(pi));
		assert.equal(calls.length, 0, "invalid entry must not register");
		assert.ok(
			lines.some((l) => l.includes(CHAINS_JSON) && l.includes("ollama") && l.includes("SKIPPED")),
			"warning must name the file, the provider, and SKIPPED",
		);
		assert.deepEqual(
			roster.resolveModels("fast"),
			["zai/kept"],
			"declared-but-invalid provider stays unavailable, so its models are filtered out",
		);
		removeChains();
	});
}

test("invalid entry does not block a valid sibling from registering", () => {
	writeChains({
		providers: {
			ollama: OLLAMA,
			broken: { baseUrl: "", api: "openai-completions", models: [{ id: "x" }] },
		},
	});
	const { calls, pi } = registrationCalls();
	const lines = captureStderr(() => providers.registerProviders(pi));
	assert.deepEqual(
		calls.map((c) => c.name),
		["ollama"],
	);
	assert.ok(lines.some((l) => l.includes("broken") && l.includes("SKIPPED")));
	removeChains();
});

test("apiKey env-ref passes through to the registered provider config", () => {
	writeChains({
		providers: {
			openrouter: {
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
				apiKey: "$OPENROUTER_API_KEY",
				models: [{ id: "z-ai/glm-4.7", contextWindow: 200000 }],
			},
		},
	});
	const { calls, pi } = registrationCalls();
	providers.registerProviders(pi);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "openrouter");
	assert.equal(calls[0].config.apiKey, "$OPENROUTER_API_KEY");
	assert.equal(calls[0].config.models[0].id, "z-ai/glm-4.7");
	assert.equal(calls[0].config.models[0].contextWindow, 200000, "contextWindow passes through");
	removeChains();
});

test("ambient session-title cascade follows a fast-tier override onto the local model", () => {
	writeChains({ fast: ["ollama/gemma3:12b"], providers: { ollama: OLLAMA } });
	const finds = [];
	let found;
	const registry = {
		find: (provider, modelId) => {
			finds.push(`${provider}/${modelId}`);
			return found;
		},
		hasConfiguredAuth: () => true,
	};
	const sessionModel = { id: "session" };

	assert.equal(
		sessionTitle.resolveTitleModel(undefined, registry, sessionModel),
		sessionModel,
		"unfindable local head falls back to the session model",
	);
	assert.deepEqual(finds, ["ollama/gemma3:12b"], "ambient cascade must look up the fast-tier head");

	found = { id: "local" };
	assert.equal(sessionTitle.resolveTitleModel(undefined, registry, sessionModel).id, "local");

	finds.length = 0;
	found = { id: "custom" };
	assert.equal(sessionTitle.resolveTitleModel("zai/custom", registry, sessionModel).id, "custom");
	assert.deepEqual(finds, ["zai/custom"], "TORUS_TITLE_MODEL still wins over the chain head");

	found = undefined;
	finds.length = 0;
	removeChains();
	assert.equal(sessionTitle.resolveTitleModel(undefined, registry, sessionModel), sessionModel);
	assert.deepEqual(finds, ["zai/glm-5.3-flash"], "built-in fast head returns with the file gone");
});

test("happy path: chains.json override reaches the engine child's --model argv", async () => {
	registry.resetRegistryForTesting();
	registry.setCustomSender(() => {});
	const dir = path.join(ENGINE_DIR, "argv-happy");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	process.env.TORUS_ARGS_DIR = dir;
	writeChains({ fast: ["zai/custom-model"] });

	process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;
	try {
		const outcome = await roster.runDelegation(
			"worker",
			"probe chains override",
			undefined,
			undefined,
			null,
			null,
			null,
			undefined,
			undefined,
			{ model: "fast" },
		);
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.model, "zai/custom-model");
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}

	const batches = readdirSync(dir)
		.filter((f) => f.startsWith("spawn-"))
		.map((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean));
	assert.ok(batches.length > 0, "engine must have been spawned");
	assert.ok(
		batches.some((args) => {
			const model = args.indexOf("--model");
			return model !== -1 && args[model + 1] === "zai/custom-model";
		}),
		"some spawn must carry --model zai/custom-model",
	);
	assert.ok(
		batches.every((args) => {
			const model = args.indexOf("--model");
			return model === -1 || args[model + 1] === "zai/custom-model";
		}),
		"no spawn may fall back to a default chain model",
	);
	removeChains();
});

test("frontmatter model: still wins over the overridden chain head", async () => {
	registry.resetRegistryForTesting();
	registry.setCustomSender(() => {});
	const dir = path.join(ENGINE_DIR, "frontmatter-pin-over-override");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	process.env.TORUS_ARGS_DIR = dir;
	writeChains({ primary: ["zai/p-custom"] });

	process.env.TORUS_ENGINE_BIN = ARGS_ENGINE;
	try {
		const outcome = await roster.runDelegation("pinned", "probe pin over override");
		assert.equal(outcome.ok, true);
		assert.equal(outcome.details.model, "zai/glm-5.3-flash");
	} finally {
		if (PREV_ENGINE_BIN === undefined) delete process.env.TORUS_ENGINE_BIN;
		else process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	}

	const batches = readdirSync(dir)
		.filter((f) => f.startsWith("spawn-"))
		.map((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean));
	assert.ok(batches.length > 0);
	assert.ok(
		batches.every((args) => args[args.indexOf("--model") + 1] === "zai/glm-5.3-flash"),
		"every attempt must run on the pinned model, never the overridden chain head",
	);
	removeChains();
});
