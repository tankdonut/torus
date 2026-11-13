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

// User-configurable model chains: the `chains` section of the unified
// config.json under TORUS_HOME overrides the built-in MODEL_CHAINS per tier.
// A tier counts only as a non-empty array of non-empty ids; absent/empty/
// malformed tiers fall back to that tier's default (mixed validity allowed),
// and a config that is not JSON warns on stderr while both chains stay
// default. Overrides ride the same provider-availability filter as the
// defaults, and agent frontmatter `model:` still wins.
//
// The same section's `providers` map registers compatible endpoints (Ollama,
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

const CONFIG_JSON = path.join(HOME, "config.json");
const DEFAULT_PRIMARY = ["zai/glm-5.3", "zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"];
const DEFAULT_FAST = ["zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"];

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

const PREV_ENGINE_BIN = process.env.TORUS_ENGINE_BIN;

// Built-in chain providers are credential-gated at resolution now, so every
// chain-resolution test needs a credential: set dummy env values (presence
// only — nothing reads them) and restore the caller's state in after().
const PREV_ZAI_KEY = process.env.ZAI_API_KEY;
const PREV_OPENCODE_KEY = process.env.OPENCODE_API_KEY;
process.env.ZAI_API_KEY = "torus-test-dummy";
process.env.OPENCODE_API_KEY = "torus-test-dummy";

// Injectable credential sources for the gate tests: empty auth.json and
// models.json fixtures — nothing answers there.
const GATE_DIR = mkdtempSync(path.join(tmpdir(), "torus-chains-gate-"));
const GATE_AUTH = path.join(GATE_DIR, "auth.json");
const GATE_MODELS = path.join(GATE_DIR, "models.json");
writeFileSync(GATE_AUTH, "{}", "utf8");
writeFileSync(GATE_MODELS, "{}", "utf8");

after(() => {
	process.env.TORUS_ENGINE_BIN = PREV_ENGINE_BIN;
	if (PREV_ZAI_KEY === undefined) delete process.env.ZAI_API_KEY;
	else process.env.ZAI_API_KEY = PREV_ZAI_KEY;
	if (PREV_OPENCODE_KEY === undefined) delete process.env.OPENCODE_API_KEY;
	else process.env.OPENCODE_API_KEY = PREV_OPENCODE_KEY;
	roster.resetFailureMemoForTesting();
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(ENGINE_DIR, { recursive: true, force: true });
	rmSync(GATE_DIR, { recursive: true, force: true });
});

/** Run body with both built-in provider env vars deleted (restored after). */
function withoutCredentialEnv(body) {
	const zai = process.env.ZAI_API_KEY;
	const opencode = process.env.OPENCODE_API_KEY;
	delete process.env.ZAI_API_KEY;
	delete process.env.OPENCODE_API_KEY;
	try {
		return body();
	} finally {
		if (zai === undefined) delete process.env.ZAI_API_KEY;
		else process.env.ZAI_API_KEY = zai;
		if (opencode === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = opencode;
	}
}

function writeChains(data) {
	writeConfig({ chains: data });
}

function writeConfig(data) {
	writeFileSync(CONFIG_JSON, JSON.stringify(data), "utf8");
}

function removeConfig() {
	rmSync(CONFIG_JSON, { force: true });
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

test("no chains section → built-in defaults, byte-identical", () => {
	removeConfig();
	assert.deepEqual(roster.resolveModels("primary"), DEFAULT_PRIMARY);
	assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST);
	assert.equal(roster.personaModel("worker"), DEFAULT_PRIMARY[0]);
	assert.deepEqual(
		roster.availableModels(),
		["zai/glm-5.3", "zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
		"deduped union of both chains",
	);
});

test("a pre-unification standalone chains file is not a source", () => {
	removeConfig();
	// The pre-unification chain-override file is gone as a config source:
	// planted under TORUS_HOME, it must not steer any tier.
	const preUnified = ["chains", ".json"].join("");
	writeFileSync(path.join(HOME, preUnified), JSON.stringify({ fast: ["zai/impostor"] }), "utf8");
	try {
		assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST);
		assert.deepEqual(roster.resolveModels("primary"), DEFAULT_PRIMARY);
	} finally {
		rmSync(path.join(HOME, preUnified), { force: true });
	}
});

test("valid override steers resolveModels and the chain head", () => {
	writeChains({ fast: ["zai/custom-model", "zai/second-choice"] });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/custom-model", "zai/second-choice"]);
	assert.deepEqual(roster.resolveModels("primary"), DEFAULT_PRIMARY, "primary stays default");
	assert.equal(roster.personaModel("worker"), DEFAULT_PRIMARY[0], "primary head unchanged");
	removeConfig();
	assert.deepEqual(
		roster.resolveModels("fast"),
		DEFAULT_FAST,
		"default returns after the section is gone",
	);
});

test("overridden entries still ride the provider-availability filter", () => {
	writeChains({ fast: ["custom/provider-x", "zai/kept", "noproviderslash"] });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/kept"]);
	assert.equal(roster.personaModel("worker"), DEFAULT_PRIMARY[0]);
	removeConfig();
});

test("malformed config.json → defaults plus a stderr warning naming the file", () => {
	writeFileSync(CONFIG_JSON, "{not json at all", "utf8");
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
		lines.every((l) => l.includes(CONFIG_JSON)),
		"warning must name the file path",
	);
	removeConfig();
});

test("non-object chains section warns and falls back to the built-ins", () => {
	writeConfig({ chains: 5 });
	let fast;
	const lines = captureStderr(() => {
		fast = roster.resolveModels("fast");
	});
	assert.deepEqual(fast, DEFAULT_FAST);
	assert.ok(
		lines.some((l) => l.includes('"chains" in config.json is not an object')),
		"the section-level warning surfaces",
	);
	removeConfig();
});

test("empty tier falls back per-tier; the other tier still overrides", () => {
	writeChains({ primary: ["zai/p-custom"], fast: [] });
	assert.deepEqual(roster.resolveModels("primary"), ["zai/p-custom"], "valid tier overrides");
	assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST, "empty tier falls back");
	assert.equal(roster.personaModel("worker"), "zai/p-custom");
	removeConfig();
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
		lines.some((l) => l.includes(CONFIG_JSON) && l.includes("fast")),
		"warning must name the file and the tier",
	);
	removeConfig();
});

test("tier with non-string entries is invalid as a whole", () => {
	writeChains({ fast: ["zai/ok", 42, null] });
	const lines = captureStderr(() => {
		assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST);
	});
	assert.ok(lines.some((l) => l.includes(CONFIG_JSON)));
	removeConfig();
});

test("unknown tiers in the section are ignored", () => {
	writeChains({ turbo: ["zai/turbo"], fast: ["zai/custom-model"] });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/custom-model"]);
	removeConfig();
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

test("providers entry registers with the mapped provider config", () => {
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
	removeConfig();
});

test("declared provider + fast override: resolveModels keeps the local model id", () => {
	writeChains({ fast: ["ollama/gemma3:12b"], providers: { ollama: OLLAMA } });
	assert.deepEqual(roster.resolveModels("fast"), ["ollama/gemma3:12b"]);
	assert.ok(roster.availableModels().includes("ollama/gemma3:12b"));
	removeConfig();
	assert.deepEqual(
		roster.resolveModels("fast"),
		DEFAULT_FAST,
		"default returns after the section is gone",
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
			lines.some((l) => l.includes(CONFIG_JSON) && l.includes("ollama") && l.includes("SKIPPED")),
			"warning must name the file, the provider, and SKIPPED",
		);
		assert.deepEqual(
			roster.resolveModels("fast"),
			["zai/kept"],
			"declared-but-invalid provider stays unavailable, so its models are filtered out",
		);
		removeConfig();
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
	removeConfig();
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
	removeConfig();
});

test("config fast tier + config providers: local model rides the availability filter", () => {
	writeConfig({ chains: { fast: ["ollama/gemma3:12b"], providers: { ollama: OLLAMA } } });
	assert.deepEqual(roster.resolveModels("fast"), ["ollama/gemma3:12b"]);
	assert.ok(roster.availableModels().includes("ollama/gemma3:12b"));
	removeConfig();
	assert.deepEqual(
		roster.resolveModels("fast"),
		DEFAULT_FAST,
		"default returns after the config is gone",
	);
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
	removeConfig();
	assert.equal(sessionTitle.resolveTitleModel(undefined, registry, sessionModel), sessionModel);
	assert.deepEqual(
		finds,
		["zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
		"built-in fast chain is walked in order with the section gone",
	);
});

test("ambient session-title walks past an unauthed zai onto the second fast entry", () => {
	removeConfig();
	const finds = [];
	let authed = false;
	const registry = {
		find: (provider, modelId) => {
			finds.push(`${provider}/${modelId}`);
			return { id: modelId };
		},
		hasConfiguredAuth: () => authed,
	};
	const sessionModel = { id: "session" };

	assert.equal(
		sessionTitle.resolveTitleModel(undefined, registry, sessionModel),
		sessionModel,
		"no authed fast entry falls back to the session model",
	);
	assert.deepEqual(finds, ["zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"]);

	authed = true;
	finds.length = 0;
	assert.equal(
		sessionTitle.resolveTitleModel(undefined, registry, sessionModel).id,
		"glm-5.3-flash",
	);
	assert.equal(finds.length, 1, "walk stops at the first authed entry");
});

test("happy path: a chains-section override reaches the engine child's --model argv", async () => {
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
	removeConfig();
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
	removeConfig();
});

// --- Concurrency caps (chains section `concurrency` map) ---

test("no config → built-in concurrency defaults, unknown models uncapped", () => {
	removeConfig();
	assert.equal(providers.modelConcurrency("zai/glm-5.3"), 5);
	assert.equal(providers.modelConcurrency("zai/glm-5.3-flash"), 50);
	assert.equal(providers.modelConcurrency("opencode-go/glm-5.3-flash"), undefined);
	assert.equal(providers.modelConcurrency("ollama/gemma3:12b"), undefined);
});

test("concurrency map overrides per model; defaults fill the rest", () => {
	writeConfig({ chains: { concurrency: { "zai/glm-5.3": 3 } } });
	assert.equal(providers.modelConcurrency("zai/glm-5.3"), 3);
	assert.equal(providers.modelConcurrency("zai/glm-5.3-flash"), 50);
	removeConfig();
});

test("one chains section carries tiers and concurrency together; a rewrite replaces it wholesale", () => {
	writeConfig({ chains: { fast: ["zai/custom-model"], concurrency: { "zai/glm-5.3": 9 } } });
	assert.deepEqual(roster.resolveModels("fast"), ["zai/custom-model"]);
	assert.equal(providers.modelConcurrency("zai/glm-5.3"), 9);
	writeConfig({ chains: { concurrency: { "zai/glm-5.3": 2 } } });
	assert.equal(providers.modelConcurrency("zai/glm-5.3"), 2);
	assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST, "the rewrite replaced the section");
	removeConfig();
});

test("malformed concurrency map warns and is ignored (defaults hold)", () => {
	writeConfig({ chains: { concurrency: "five" } });
	const lines = captureStderr(() => providers.modelConcurrencyMap());
	assert.equal(providers.modelConcurrency("zai/glm-5.3"), 5);
	assert.ok(lines.some((l) => l.includes('"concurrency" must be an object')));
	removeConfig();

	writeConfig({ chains: { concurrency: { "zai/glm-5.3": 0, "zai/glm-5.3-flash": "many" } } });
	const entryLines = captureStderr(() => providers.modelConcurrencyMap());
	assert.equal(providers.modelConcurrency("zai/glm-5.3"), 5);
	assert.equal(providers.modelConcurrency("zai/glm-5.3-flash"), 50);
	assert.equal(entryLines.filter((l) => l.includes("concurrency cap for")).length, 2);
	removeConfig();
});

test("rosterText reports caps for available models", () => {
	removeConfig();
	const text = roster.rosterText();
	assert.ok(text.includes("concurrency caps"));
	assert.ok(text.includes("zai/glm-5.3=5"));
	assert.ok(text.includes("zai/glm-5.3-flash=50"));
	assert.ok(text.includes("opencode-go/glm-5.3-flash=uncapped"));
});

test("plannedRunModel mirrors runDelegation's first-model resolution", () => {
	removeConfig();
	assert.equal(roster.plannedRunModel("worker"), "zai/glm-5.3");
	assert.equal(roster.plannedRunModel("pinned"), "zai/glm-5.3-flash");
	assert.equal(roster.plannedRunModel("worker", "fast"), "zai/glm-5.3-flash");
	assert.equal(
		roster.plannedRunModel("worker", "opencode-go/glm-5.3-flash"),
		"opencode-go/glm-5.3-flash",
	);
	assert.equal(roster.plannedRunModel("worker", "zai/not-a-model"), undefined);
	assert.equal(roster.plannedRunModel("no-such-agent"), undefined);
});

test("concurrencyWarning flags only models pushed over cap", () => {
	removeConfig();
	const warning = roster.concurrencyWarning(
		[
			"zai/glm-5.3",
			"zai/glm-5.3",
			"zai/glm-5.3-flash",
			"zai/glm-5.3-flash",
			"opencode-go/glm-5.3-flash",
		],
		{ "zai/glm-5.3": 4, "zai/glm-5.3-flash": 48, "opencode-go/glm-5.3-flash": 99 },
	);
	assert.ok(typeof warning === "string");
	assert.ok(warning.includes("zai/glm-5.3: 6 parallel runs vs cap 5"));
	assert.ok(!warning.includes("zai/glm-5.3-flash: "));
	assert.ok(!warning.includes("opencode-go"));
	// Exactly at cap (48 + 2 = 50) is not over, and uncapped models never flag.
	assert.equal(
		roster.concurrencyWarning(["zai/glm-5.3-flash", "zai/glm-5.3-flash"], {
			"zai/glm-5.3-flash": 48,
		}),
		undefined,
	);
	assert.equal(roster.withWarning("done", "warn"), "warn\n\ndone");
	assert.equal(roster.withWarning("done", undefined), "done");
});

// --- Credential presence gate (built-in providers) ---

test("gate: built-in entries drop when no credential source answers", () => {
	withoutCredentialEnv(() => {
		assert.equal(
			providers.hasCredential("zai", { authPath: GATE_AUTH, modelsPath: GATE_MODELS }),
			false,
		);
		assert.equal(
			providers.hasCredential("opencode-go", { authPath: GATE_AUTH, modelsPath: GATE_MODELS }),
			false,
		);
		writeChains({
			fast: ["ollama/gemma3:12b", "zai/gone", "opencode-go/gone"],
			providers: { ollama: OLLAMA },
		});
		assert.deepEqual(
			roster.resolveModels("fast", { authPath: GATE_AUTH, modelsPath: GATE_MODELS }),
			["ollama/gemma3:12b"],
			"custom declared provider stays, credential-less built-ins drop",
		);
		assert.deepEqual(
			providers.providerAvailabilities({ authPath: GATE_AUTH, modelsPath: GATE_MODELS }),
			{
				zai: false,
				"opencode-go": false,
				ollama: true,
			},
		);
		removeConfig();
	});
});

test("gate: a dummy env var alone credentiials the provider", () => {
	withoutCredentialEnv(() => {
		process.env.ZAI_API_KEY = "torus-test-dummy";
		writeChains({ fast: ["zai/back", "opencode-go/still-gone"] });
		assert.deepEqual(
			roster.resolveModels("fast", { authPath: GATE_AUTH, modelsPath: GATE_MODELS }),
			["zai/back"],
			"env presence credentiials zai even with empty auth.json and models.json",
		);
		removeConfig();
	});
});

test("gate: a stored auth.json credential credentiials the provider", () => {
	withoutCredentialEnv(() => {
		const authPath = path.join(GATE_DIR, "fixture-auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({ zai: { type: "api", key: "torus-test-dummy" } }),
			"utf8",
		);
		writeChains({ fast: ["zai/back"] });
		assert.deepEqual(
			roster.resolveModels("fast", { authPath, modelsPath: GATE_MODELS }),
			["zai/back"],
			"auth.json presence credentiials zai with no env var set",
		);
		removeConfig();
	});
});

test("gate: a models.json apiKey literal (even an unresolved $NAME) credentiials the provider", () => {
	withoutCredentialEnv(() => {
		const modelsPath = path.join(GATE_DIR, "fixture-models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { zai: { apiKey: "$ZAI_API_KEY" } } }),
			"utf8",
		);
		writeChains({ fast: ["zai/back"] });
		assert.deepEqual(
			roster.resolveModels("fast", { authPath: GATE_AUTH, modelsPath }),
			["zai/back"],
			"the unresolved $NAME literal counts as present — it is never resolved here",
		);
		removeConfig();
	});
});

test("startup notice: credential-less built-ins each print one line naming provider and env var", () => {
	withoutCredentialEnv(() => {
		// registerProviders reads the real credential sources; point the
		// engine agent dir at an empty temp dir so nothing answers.
		const emptyAgentDir = path.join(GATE_DIR, "empty-agent");
		mkdirSync(emptyAgentDir, { recursive: true });
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
		const { calls, pi } = registrationCalls();
		try {
			const lines = captureStderr(() => providers.registerProviders(pi));
			const notices = lines.filter((l) => l.includes("[torus: chains] no credential for"));
			assert.equal(notices.length, 2, "exactly one notice per credential-less built-in");
			assert.ok(
				notices.some((l) => l.includes("zai") && l.includes("ZAI_API_KEY")),
				"the zai notice names the provider and its env var",
			);
			assert.ok(
				notices.some((l) => l.includes("opencode-go") && l.includes("OPENCODE_API_KEY")),
				"the opencode-go notice names the provider and its env var",
			);
			assert.ok(
				notices.every((l) => !l.includes("torus-test-dummy")),
				"no credential value may ever appear in the notice",
			);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
		assert.deepEqual(
			calls.map((c) => c.name),
			[],
			"notice mode registers nothing",
		);
	});
});

// --- Session no-work cooldown (failure memo) ---

test("no-work cooldown: a memoized head drops from resolution until the TTL expires", () => {
	removeConfig();
	roster.resetFailureMemoForTesting();
	assert.equal(roster.resolveModels("primary")[0], "zai/glm-5.3");
	// Pin the mark time: a default Date.now() mark races the query below into
	// the same millisecond under load.
	const now = Date.now();
	roster.markModelFailed("zai/glm-5.3", now);
	assert.equal(roster.resolveModels("primary")[0], "zai/glm-5.3-flash");
	assert.equal(roster.plannedRunModel("worker"), "zai/glm-5.3-flash");
	assert.equal(roster.isModelMemoFailed("zai/glm-5.3", now + 299_999), true, "just inside the TTL");
	assert.equal(
		roster.isModelMemoFailed("zai/glm-5.3", now + 300_000),
		false,
		"at the TTL it expires",
	);
	// A mark older than the TTL is inert: expiry restores the head.
	roster.markModelFailed("zai/glm-5.3", now - 300_000);
	assert.equal(roster.resolveModels("primary")[0], "zai/glm-5.3", "expiry restores the head");
	roster.resetFailureMemoForTesting();
});

test("no-work cooldown: memoizing every chain entry falls back to the availability-only list", () => {
	removeConfig();
	roster.resetFailureMemoForTesting();
	for (const model of [...DEFAULT_PRIMARY, ...DEFAULT_FAST]) roster.markModelFailed(model);
	assert.deepEqual(roster.resolveModels("primary"), DEFAULT_PRIMARY);
	assert.deepEqual(roster.resolveModels("fast"), DEFAULT_FAST);
	assert.ok(roster.availableModels().includes("zai/glm-5.3"));
	roster.resetFailureMemoForTesting();
});

test("no-work cooldown: exact-id overrides bypass the memo, chain shorthands ride it", () => {
	removeConfig();
	roster.resetFailureMemoForTesting();
	roster.markModelFailed("zai/glm-5.3");
	assert.equal(roster.resolveRequestedModel("zai/glm-5.3"), "zai/glm-5.3");
	assert.equal(roster.resolveRequestedModel("primary"), "zai/glm-5.3-flash");
	assert.equal(roster.plannedRunModel("worker", "zai/glm-5.3"), "zai/glm-5.3");
	roster.resetFailureMemoForTesting();
});
