/**
 * torus — GLM provider routing.
 *
 * Both chain providers are BUILT IN to stock pi: `zai` and `opencode-go` are
 * engine KnownProviders, so torus registers neither. Authenticate via pi's
 * `/login zai` and `/login opencode-go` (the gateway also reads
 * OPENCODE_API_KEY); credential resolution is the engine's job.
 *
 * The chains config is the unified config's `chains` section: tiers plus a
 * `providers` map of compatible-endpoint registrations — local
 * Ollama/LM Studio, OpenRouter, anything speaking an API the engine
 * already supports. Each providers entry becomes one pi.registerProvider call
 * in registerProviders(), and its models are chain-addressable as
 * `<provider-name>/<model-id>`. pi's KnownProvider ids have no ollama/lmstudio
 * entries, so this registration IS the mechanism for local endpoints.
 */

import type { KnownApi } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { configFilePath, readSection, type SectionSource } from "../config/loader.js";
import { gateExtension, type PlatformSupport } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

export const MODEL_CHAINS = {
	primary: ["zai/glm-5.3", "zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
	fast: ["zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
} as const satisfies Record<string, readonly string[]>;

export type ChainTier = keyof typeof MODEL_CHAINS;

/**
 * Resolve the chains section from the unified config: a present section is
 * the whole chains config (tiers, providers, concurrency — never merged
 * with the built-ins); an absent section leaves the built-in defaults.
 * Read every call — files are tiny and edits apply without a restart.
 */
function chainsSection(): {
	value: Record<string, unknown> | undefined;
	source: SectionSource;
	warning?: string;
} {
	return readSection("chains");
}

/**
 * Origin label for warnings: where a resolved chains section came from.
 * The default tier carries no section to warn about, so its label names
 * the built-ins it serves.
 */
function chainsOrigin(source: SectionSource): string {
	return source === "config" ? configFilePath() : "the built-in chains";
}

/**
 * One tier lookup over a resolved chains section: a tier counts only when it
 * is a non-empty array of non-empty model ids; absent, empty, or malformed
 * tiers yield undefined and fall back to that tier's default (mixed validity
 * is fine). Tiers not in MODEL_CHAINS are ignored. Malformed tiers warn naming
 * `origin`, where the section came from.
 */
function tierChain(
	tiers: Record<string, unknown> | undefined,
	tier: ChainTier,
	origin: string,
): readonly string[] | undefined {
	if (tiers === undefined) return undefined;
	const candidate = tiers[tier];
	if (candidate === undefined) return undefined;
	if (
		Array.isArray(candidate) &&
		candidate.length > 0 &&
		candidate.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	) {
		return candidate;
	}
	console.error(
		`torus: ${origin}: tier "${tier}" must be a non-empty array of model ids — using the built-in ${tier} chain`,
	);
	return undefined;
}

/**
 * Effective chain for a tier: a valid chains-section entry wins, else the
 * built-in default. One read plus at most one warning per call (malformed
 * config or malformed tier) — the same per-call cost model as before.
 */
export function modelChain(tier: ChainTier): readonly string[] {
	const { value, source, warning } = chainsSection();
	if (warning !== undefined) console.error(`torus: ${warning}`);
	return tierChain(value, tier, chainsOrigin(source)) ?? MODEL_CHAINS[tier];
}

/** API ids the pinned engine's `KnownApi` union admits (pi-ai types.d.ts). */
const SUPPORTED_APIS: readonly KnownApi[] = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"mistral-conversations",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"pi-messages",
];

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** A validated `providers` entry from the chains section, ready for pi.registerProvider. */
export interface ChainProviderRegistration {
	name: string;
	config: ProviderConfig;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Map one chains-section model entry to a full chat model config. Optional
 * fields
 * the engine already knows (contextWindow, maxTokens, reasoning, input) pass
 * through; defaults mirror the engine's own bare-entry normalization
 * (provider-composer): text-only input, no reasoning, zero cost, 128k context,
 * 16k output. Unknown extra fields are ignored.
 */
function chainModelConfig(raw: unknown): ProviderModelConfig | null {
	if (typeof raw !== "object" || raw === null) return null;
	const entry = raw as Record<string, unknown>;
	const id = nonEmptyString(entry["id"]);
	if (id === undefined) return null;
	const input = Array.isArray(entry["input"])
		? entry["input"].filter((v): v is "text" | "image" => v === "text" || v === "image")
		: [];
	return {
		id,
		name: nonEmptyString(entry["name"]) ?? id,
		reasoning: entry["reasoning"] === true,
		input: input.length > 0 ? input : ["text"],
		cost: ZERO_COST,
		contextWindow: positiveNumber(entry["contextWindow"]) ?? 128_000,
		maxTokens: positiveNumber(entry["maxTokens"]) ?? 16_384,
	};
}

/**
 * Validated `providers` map from the resolved chains section (the unified
 * config's `chains`): every good entry maps to one pi.registerProvider
 * call, every bad one to a warning naming the provider. Silent by design —
 * callers decide whether warnings reach stderr — and a broken entry never
 * fails the section: the rest still registers and the built-in chains hold.
 */
function chainProviderRegistrations(
	section: Record<string, unknown> | undefined,
	origin: string,
): {
	valid: ChainProviderRegistration[];
	warnings: string[];
} {
	if (section === undefined) return { valid: [], warnings: [] };
	const raw = section["providers"];
	if (raw === undefined) return { valid: [], warnings: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			valid: [],
			warnings: [
				`torus: ${origin}: "providers" must be an object mapping names to endpoint entries — ignored`,
			],
		};
	}
	const valid: ChainProviderRegistration[] = [];
	const warnings: string[] = [];
	for (const [name, entry] of Object.entries(raw)) {
		const skip = (reason: string) =>
			warnings.push(`torus: ${origin}: provider "${name}" ${reason} — SKIPPED`);
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			skip("must be an object with baseUrl, api, and models");
			continue;
		}
		const fields = entry as Record<string, unknown>;
		const baseUrl = nonEmptyString(fields["baseUrl"]);
		if (baseUrl === undefined) {
			skip('"baseUrl" must be a non-empty string');
			continue;
		}
		const api = fields["api"];
		if (typeof api !== "string" || !SUPPORTED_APIS.includes(api as KnownApi)) {
			skip(`"api" must be one of: ${SUPPORTED_APIS.join(", ")}`);
			continue;
		}
		const rawModels = fields["models"];
		if (!Array.isArray(rawModels) || rawModels.length === 0) {
			skip('"models" must be a non-empty array');
			continue;
		}
		const models: ProviderModelConfig[] = [];
		let badModel = false;
		for (const rawModel of rawModels) {
			const model = chainModelConfig(rawModel);
			if (model === null) {
				badModel = true;
				break;
			}
			models.push(model);
		}
		if (badModel) {
			skip('every "models" entry must be an object with a non-empty string "id"');
			continue;
		}
		const apiKey = fields["apiKey"];
		if (apiKey !== undefined && nonEmptyString(apiKey) === undefined) {
			skip(
				'"apiKey" must be a non-empty string (env refs like "$OPENROUTER_API_KEY" expand at request time)',
			);
			continue;
		}
		valid.push({
			name,
			config: {
				baseUrl,
				api,
				// The engine requires some auth method on every provider; a keyless
				// local endpoint gets a dummy literal instead — the same trick as the
				// engine's own models.json Ollama example ("apiKey": "ollama"), which
				// the server ignores.
				apiKey: nonEmptyString(apiKey) ?? name,
				models,
			},
		});
	}
	return { valid, warnings };
}

/** Default model for spawned team members: head of the fast chain. */
export const DEFAULT_MEMBER_MODEL = MODEL_CHAINS.fast[0];

/**
 * Built-in per-model delegation caps: how many torus runs may target one
 * model in parallel before the provider's account-level concurrent-session
 * limit starts rejecting requests. Provenance: Z.ai publishes no official
 * numbers (its rate-limits docs page redirects to the account console; the
 * caps are per-account, per-model, in-flight request counts, tier-dependent
 * and dynamically adjusted), so these mirror widely reported GLM Coding
 * Plan figures — roughly 5 concurrent sessions on glm-5.3 versus far more
 * on the flash tier. They are scheduling hints for delegation sizing, not a
 * request rate limiter; override per model via the chains section's
 * `concurrency` map to match your account tier.
 */
export const MODEL_CONCURRENCY_DEFAULTS: Readonly<Record<string, number>> = {
	"zai/glm-5.3": 5,
	"zai/glm-5.3-flash": 50,
};

/**
 * Effective per-model caps: MODEL_CONCURRENCY_DEFAULTS overlaid with the
 * chains section's `concurrency` map (`{"provider/model": <positive number>}`),
 * per model — a config entry wins for its model, defaults fill the rest
 * (the same mixed-validity model as tiers). A value that is not an object,
 * or an entry that is not a positive finite number, warns naming `origin`
 * and is ignored per model, never failing the section. Read every call,
 * like modelChain, so edits apply without a restart.
 */
export function modelConcurrencyMap(): Record<string, number> {
	const caps: Record<string, number> = { ...MODEL_CONCURRENCY_DEFAULTS };
	const { value, source } = chainsSection();
	const origin = chainsOrigin(source);
	const raw = value === undefined ? undefined : value["concurrency"];
	if (raw === undefined) return caps;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		console.error(
			`torus: ${origin}: "concurrency" must be an object mapping model ids to positive numbers — ignored`,
		);
		return caps;
	}
	for (const [model, entry] of Object.entries(raw)) {
		const cap = positiveNumber(entry);
		if (cap === undefined) {
			console.error(
				`torus: ${origin}: concurrency cap for "${model}" must be a positive number — ignored`,
			);
			continue;
		}
		caps[model] = cap;
	}
	return caps;
}

/**
 * Parallel-run cap for one model: the chains section's `concurrency` entry
 * when present, else the built-in default, else undefined (no known cap —
 * the model is treated as unconstrained).
 */
export function modelConcurrency(model: string): number | undefined {
	return modelConcurrencyMap()[model];
}

/**
 * Providers whose models chains may resolve to: the engine's built-in `zai`
 * and `opencode-go` (declared = available; credential resolution is the
 * engine's job, so the roster filter never drops their chain entries for
 * lacking a torus-side credential gate), and every validly-declared provider
 * from the resolved chains section.
 */
export function providerAvailabilities(): Record<string, boolean> {
	const available: Record<string, boolean> = {
		zai: true,
		"opencode-go": true,
	};
	const { value, source } = chainsSection();
	for (const { name } of chainProviderRegistrations(value, chainsOrigin(source)).valid) {
		available[name] = true;
	}
	return available;
}

export function registerProviders(pi: ExtensionAPI): void {
	// Only the section-level warning (a malformed config.json) surfaces, once
	// at startup.
	const { value, source, warning } = chainsSection();
	if (warning !== undefined) console.error(`torus: ${warning}`);
	const origin = chainsOrigin(source);
	const { valid, warnings } = chainProviderRegistrations(value, origin);
	for (const entry of warnings) console.error(entry);
	for (const { name, config } of valid) {
		try {
			// Registering can still throw (engine-side validation, colliding with a
			// built-in provider's shape) — one bad entry must never take the harness down.
			pi.registerProvider(name, config);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(
				`torus: ${origin}: provider "${name}" rejected by the engine (${reason}) — SKIPPED`,
			);
		}
	}
}

export default function providersExtension(pi: ExtensionAPI): void {
	if (!gateExtension("providers", PLATFORM_SUPPORT)) return;
	registerProviders(pi);
}
