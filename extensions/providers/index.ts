/**
 * torus — GLM provider routing.
 *
 * The `zai` provider is BUILT IN to stock pi (verified via
 * --list-models against the pinned engine: glm-5.3 1M/131K, glm-5.3-flash 1M with image input) —
 * authenticate via pi's `/login zai`. torus does not re-register it.
 *
 * This module registers only the opencode-go gateway as the tail fallback:
 *   glm-5.3 -> glm-5.3-flash -> opencode-go glm-5.3-flash.
 * It registers ONLY when its credentials are present, so keyless runs (CI,
 * --list-models) stay clean.
 *
 * chains.json also carries a `providers` map of compatible-endpoint
 * registrations — local Ollama/LM Studio, OpenRouter, anything speaking an API
 * the engine already supports. Each entry becomes one pi.registerProvider call
 * in registerProviders(), and its models are chain-addressable as
 * `<provider-name>/<model-id>`. pi's KnownProvider ids have no ollama/lmstudio
 * entries, so this registration IS the mechanism for local endpoints.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { KnownApi } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { torusHome } from "../fsutil.js";

const TEXT: ("text" | "image")[] = ["text"];
const TEXT_IMAGE: ("text" | "image")[] = ["text", "image"];

/** GLM catalog for gateway providers (caps mirrored from pi's built-in zai entries). */
const GLM_MODELS = [
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		reasoning: true,
		input: TEXT,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3 Flash",
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		reasoning: true,
		input: TEXT_IMAGE,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

export const MODEL_CHAINS = {
	primary: ["zai/glm-5.3", "zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
	fast: ["zai/glm-5.3-flash", "opencode-go/glm-5.3-flash"],
} as const satisfies Record<string, readonly string[]>;

export type ChainTier = keyof typeof MODEL_CHAINS;

/** User chain-override file: `<torusHome>/chains.json`, so TORUS_HOME redirects tests. */
export function chainsFile(): string {
	return path.join(torusHome(), "chains.json");
}

/**
 * Raw tiers from chains.json: null when the file is malformed (not JSON, or
 * not an object), otherwise the parsed entries keyed by tier. Absent tiers are
 * simply missing from the map.
 */
function readChainTiers(file: string): Record<string, unknown> | null {
	return parseChainsFile(file, (message) => console.error(message));
}

/**
 * Parse chains.json: null when the file is malformed (not JSON, or not an
 * object), otherwise the parsed object. `onError` receives the warning text —
 * readChainTiers prints it per call, while the provider-availability path
 * stays silent so statusline repaints cannot spam stderr.
 */
function parseChainsFile(
	file: string,
	onError?: (message: string) => void,
): Record<string, unknown> | null {
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		onError?.(`torus: malformed ${file} (${reason}) — using built-in model chains`);
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		onError?.(
			`torus: malformed ${file} (expected an object of tier arrays) — using built-in model chains`,
		);
		return null;
	}
	return parsed as Record<string, unknown>;
}

/**
 * Effective chain for a tier: a valid chains.json override wins, else the
 * built-in default. A tier counts only when it is a non-empty array of
 * non-empty model ids; absent, empty, or malformed tiers fall back to that
 * tier's default (mixed validity is fine). Tiers not in MODEL_CHAINS are
 * ignored. Read every call — the file is tiny and edits apply without a
 * restart.
 */
export function modelChain(tier: ChainTier): readonly string[] {
	const file = chainsFile();
	const tiers = readChainTiers(file);
	if (tiers === null) return MODEL_CHAINS[tier];
	const candidate = tiers[tier];
	if (candidate === undefined) return MODEL_CHAINS[tier];
	if (
		Array.isArray(candidate) &&
		candidate.length > 0 &&
		candidate.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	) {
		return candidate;
	}
	console.error(
		`torus: ${file}: tier "${tier}" must be a non-empty array of model ids — using the built-in ${tier} chain`,
	);
	return MODEL_CHAINS[tier];
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

/** A validated `providers` entry from chains.json, ready for pi.registerProvider. */
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
 * Map one chains.json model entry to a full chat model config. Optional fields
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
 * Validated `providers` map from chains.json: every good entry maps to one
 * pi.registerProvider call, every bad one to a warning naming the provider.
 * Silent by design — callers decide whether warnings reach stderr — and a
 * broken entry never fails the file: the rest still registers and the
 * built-in chains hold.
 */
function chainProviderRegistrations(file: string): {
	valid: ChainProviderRegistration[];
	warnings: string[];
} {
	const raw = parseChainsFile(file)?.["providers"];
	if (raw === undefined) return { valid: [], warnings: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			valid: [],
			warnings: [
				`torus: ${file}: "providers" must be an object mapping names to endpoint entries — ignored`,
			],
		};
	}
	const valid: ChainProviderRegistration[] = [];
	const warnings: string[] = [];
	for (const [name, entry] of Object.entries(raw)) {
		const skip = (reason: string) =>
			warnings.push(`torus: ${file}: provider "${name}" ${reason} — SKIPPED`);
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
 * Providers whose models chains may resolve to: built-in `zai`, the
 * env-gated `opencode-go` gateway, and every validly-declared chains.json
 * provider. Declared = available: credential resolution is the engine's job
 * (the entry's apiKey env-ref, or its dummy key on keyless endpoints), so the
 * roster filter never drops chains.json models for lacking a torus-side
 * credential gate.
 */
export function providerAvailabilities(): Record<string, boolean> {
	const available: Record<string, boolean> = {
		zai: true,
		"opencode-go": Boolean(process.env["TORUS_OCGO_API_KEY"] && process.env["TORUS_OCGO_BASE_URL"]),
	};
	for (const { name } of chainProviderRegistrations(chainsFile()).valid) {
		available[name] = true;
	}
	return available;
}

export function registerProviders(pi: ExtensionAPI): void {
	if (providerAvailabilities()["opencode-go"]) {
		pi.registerProvider("opencode-go", {
			baseUrl: process.env["TORUS_OCGO_BASE_URL"] as string,
			api: "openai-completions",
			apiKey: "$TORUS_OCGO_API_KEY",
			models: GLM_MODELS,
		});
	}
	const file = chainsFile();
	const { valid, warnings } = chainProviderRegistrations(file);
	for (const warning of warnings) console.error(warning);
	for (const { name, config } of valid) {
		try {
			// Registering can still throw (engine-side validation, colliding with a
			// built-in provider's shape) — one bad entry must never take the harness down.
			pi.registerProvider(name, config);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(
				`torus: ${file}: provider "${name}" rejected by the engine (${reason}) — SKIPPED`,
			);
		}
	}
}

export default function providersExtension(pi: ExtensionAPI): void {
	registerProviders(pi);
}
