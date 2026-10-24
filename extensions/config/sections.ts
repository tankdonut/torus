/**
 * Registry of the unified config's top-level sections.
 *
 * torus user config lives in one `config.json` under the torus home
 * (${TORUS_HOME:-~/.torus}). Each top-level section replaced a standalone
 * pre-unification file named by `legacyFile` (keys without a legacyFile,
 * such as permissionMode, were never files). `torus config status|migrate`
 * (runtime/bin/torus.mjs → extensions/config/cli.ts) walks this registry so
 * the CLI and any TS extension share one section list instead of two
 * hand-maintained copies.
 *
 * Pure data on purpose: no imports and no filesystem access, so the
 * plain-node launcher path (after its strip-types re-exec) and engine
 * extensions can both load it cheaply.
 */
export interface SectionSpec {
	/** Top-level key of the section inside config.json. */
	name: string;
	/** Pre-unification standalone file under the torus home, if any. */
	legacyFile?: string;
	/** One-line description of what the section configures. */
	description: string;
}

export const CONFIG_SECTIONS: readonly SectionSpec[] = [
	{
		name: "chains",
		legacyFile: "chains.json",
		description: "Model chains per tier plus compatible-provider endpoints",
	},
	{
		name: "automode",
		legacyFile: "automode.json",
		description: "Auto permission-mode rules and circuit-breaker settings",
	},
	{
		name: "serve",
		legacyFile: "serve.json",
		description:
			"HTTP server bind, port, and scheduled triggers (tokenPath stays in serve.json; auth is runtime state)",
	},
	{
		name: "keywords",
		legacyFile: "keywords.json",
		description: "Keyword rows injected into the system prompt",
	},
	{
		name: "permissionMode",
		description: "Default permission mode for sessions (top-level key, no legacy file)",
	},
];
