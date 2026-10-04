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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/** Default model for spawned team members: head of the fast chain. */
export const DEFAULT_MEMBER_MODEL = MODEL_CHAINS.fast[0];

export function providerAvailabilities(): { zai: boolean; "opencode-go": boolean } {
	return {
		zai: true,
		"opencode-go": Boolean(process.env["TORUS_OCGO_API_KEY"] && process.env["TORUS_OCGO_BASE_URL"]),
	};
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
}

export default function providersExtension(pi: ExtensionAPI): void {
	registerProviders(pi);
}
