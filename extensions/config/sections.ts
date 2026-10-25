/**
 * Registry of the unified config's top-level sections.
 *
 * torus user config lives in one `config.json` under the torus home
 * (${TORUS_HOME:-~/.torus}); each section below is a top-level key of that
 * file and the only source of its settings. The launcher's `torus config`
 * subcommand (runtime/bin/torus.mjs → extensions/config/cli.ts) walks this
 * registry so the CLI and any TS extension share one section list instead
 * of two hand-maintained copies.
 *
 * Pure data on purpose: no imports and no filesystem access, so the
 * plain-node launcher path (after its strip-types re-exec) and engine
 * extensions can both load it cheaply.
 */
export interface SectionSpec {
	/** Top-level key of the section inside config.json. */
	name: string;
	/** One-line description of what the section configures. */
	description: string;
}

/**
 * Sections a project-level `.torus/config.json` (at the session's working
 * directory) may set: quality-of-life knobs only. chains, serve, keywords,
 * and permissionMode stay user-level — a checked-in repo must not be able to
 * redirect model traffic, inject prompt keywords, or opt sessions into
 * automode. The automode section is project-readable too, but only its
 * tightening keys (PROJECT_AUTOMODE_KEYS); the consumer enforces that split.
 */
export const PROJECT_READABLE_SECTIONS: readonly string[] = [
	"ui",
	"sessionTitle",
	"guards",
	"hashline",
	"interactive",
	"monitor",
	"notify",
	"commentChecker",
	"team",
	"reflection",
	"automode",
];

/** Keys of the automode section a project file may set: tightening only. */
export const PROJECT_AUTOMODE_KEYS: readonly string[] = ["deny", "ask"];

export const CONFIG_SECTIONS: readonly SectionSpec[] = [
	{
		name: "chains",
		description: "Model chains per tier plus compatible-provider endpoints",
	},
	{
		name: "automode",
		description: "Auto permission-mode rules and circuit-breaker settings",
	},
	{
		name: "serve",
		description:
			"HTTP server bind, port, token path, and scheduled triggers (auth is runtime state)",
	},
	{
		name: "keywords",
		description: "Keyword rows injected into the system prompt",
	},
	{
		name: "permissionMode",
		description: "Default permission mode for sessions (top-level key, not an object)",
	},
];
