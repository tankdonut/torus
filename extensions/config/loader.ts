/**
 * torus config — unified config.json loader kernel.
 *
 * One user-level file under the torus home replaces the scattered legacy
 * files (chains.json, automode.json, ...): a section missing from config.json
 * falls back to its legacy file, a section present in both is served from
 * config.json with a deprecation warning pointing at `torus config migrate`,
 * and env always beats config. Parsing is best-effort by contract — bad input
 * degrades to defaults with a warning, never a throw — so consumers can call
 * this on every startup unguarded.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { torusHome } from "../fsutil.js";

export const CONFIG_FILE_NAME = "config.json";

/**
 * Path of the unified config file under the torus home. Home resolution is
 * fsutil's torusHome() itself — imported, not mirrored — so the loader and
 * every other fsutil consumer resolve the same root by construction,
 * including the TORUS_HOME=""-wins case under nullish coalescing. fsutil
 * reads live process.env per call; callers sandbox via process.env.TORUS_HOME.
 */
export function configFilePath(): string {
	return path.join(torusHome(), CONFIG_FILE_NAME);
}

export type ConfigLoad = { config: Record<string, unknown>; warning?: string };

/**
 * Read and parse a config.json (defaults to the live config file). Missing
 * file → empty config with no warning; unreadable file, malformed JSON, or a
 * non-object root → empty config plus one warning naming the path and reason.
 * Never throws.
 */
export function loadConfigFile(file?: string): ConfigLoad {
	const target = file ?? configFilePath();
	let raw: string;
	try {
		raw = readFileSync(target, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { config: {} };
		return {
			config: {},
			warning: `${target}: unreadable (${code ?? "read error"}); using empty config`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { config: {}, warning: `${target}: not valid JSON; using empty config` };
	}
	if (!isPlainObject(parsed)) {
		return { config: {}, warning: `${target}: root is not a JSON object; using empty config` };
	}
	return { config: parsed };
}

export type SectionSource = "config" | "legacy" | "default";

/**
 * Legacy section provider: a bare loader function (reported as "legacy file")
 * or a wrapper carrying a human-readable source hint (e.g. "chains.json") for
 * the deprecation warning shown when config.json shadows it.
 */
export type LegacySection<T> =
	| (() => T | undefined)
	| { load: () => T | undefined; sourceHint: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Legacy loaders are best-effort by the same contract as this module; a
// throwing one degrades to "no legacy value" instead of breaking the caller.
function invokeLegacy<T>(load: () => T | undefined): T | undefined {
	try {
		return load();
	} catch {
		return undefined;
	}
}

/**
 * Resolve one config section by precedence: a config.json section that is a
 * plain object beats the legacy loader, legacy beats default. When config.json
 * wins and the legacy loader would also return a value, exactly one
 * deprecation warning is attached. A section present but not an object warns,
 * names the section, and falls to legacy. `parsed` defaults to a fresh
 * loadConfigFile(); pass it explicitly on hot paths to avoid re-reading the
 * file per section. Never throws.
 */
export function readSection<T>(
	name: string,
	legacy?: LegacySection<T>,
	parsed?: Record<string, unknown>,
): { value: T | undefined; source: SectionSource; warning?: string } {
	// One fresh load supplies both the sections and its own warning; a failed
	// load (unreadable/malformed file) yields an empty config, so its warning
	// rides along on the legacy/default fall-through, the only branch reachable.
	let config: Record<string, unknown>;
	let loadWarning: string | undefined;
	if (parsed === undefined) {
		const loaded = loadConfigFile();
		config = loaded.config;
		loadWarning = loaded.warning;
	} else {
		config = parsed;
	}
	const load = typeof legacy === "function" ? legacy : legacy?.load;
	const hint =
		typeof legacy === "function" || legacy === undefined ? "legacy file" : legacy.sourceHint;
	const legacyValue = load === undefined ? undefined : invokeLegacy(load);

	if (!Object.hasOwn(config, name)) {
		const result: { value: T | undefined; source: SectionSource; warning?: string } = {
			value: legacyValue,
			source: legacyValue === undefined ? "default" : "legacy",
		};
		if (loadWarning !== undefined) result.warning = loadWarning;
		return result;
	}
	const section = config[name];
	if (isPlainObject(section)) {
		const result: { value: T | undefined; source: SectionSource; warning?: string } = {
			value: section as unknown as T,
			source: "config",
		};
		if (legacyValue !== undefined) {
			result.warning = `config: "${name}" is set in config.json and shadowed from ${hint}; run torus config migrate`;
		}
		return result;
	}
	return {
		value: legacyValue,
		source: legacyValue === undefined ? "default" : "legacy",
		warning: `config: "${name}" in config.json is not an object; using ${hint}`,
	};
}

/**
 * Env-over-config precedence for one knob: a defined envValue wins outright
 * (even `false`), then configValue, then fallback. The returned source says
 * which tier supplied the value.
 */
export function configOverEnv<T>(
	envValue: T | undefined,
	configValue: T | undefined,
	fallback: T,
): { value: T; source: "env" | "config" | "default" } {
	if (envValue !== undefined) return { value: envValue, source: "env" };
	if (configValue !== undefined) return { value: configValue, source: "config" };
	return { value: fallback, source: "default" };
}

/**
 * Parse an env-var boolean: "0"/"false" → false, "1"/"true" → true, anything
 * else (including unset) → undefined so the knob falls through to config.
 *
 * Knob recipe — env beats config beats default, one line:
 *   configOverEnv(parseEnvBoolean(process.env["X"]), section.myKnob, default)
 */
export function parseEnvBoolean(raw: string | undefined): boolean | undefined {
	if (raw === "0" || raw === "false") return false;
	if (raw === "1" || raw === "true") return true;
	return undefined;
}

export type SectionSnapshot = {
	name: string;
	source: SectionSource | "env" | "absent";
	summary: string;
};

const SNAPSHOT_SOURCES = new Set<string>(["config", "legacy", "default", "env", "absent"]);

/**
 * Normalize status-output entries into the one serializable shape the CLI and
 * tests share: entries without a non-empty name are dropped, non-string
 * summaries become "", unknown sources become "absent"; order is preserved.
 */
export function effectiveConfigSnapshot(sections: SectionSnapshot[]): SectionSnapshot[] {
	const out: SectionSnapshot[] = [];
	for (const entry of sections) {
		if (!isPlainObject(entry)) continue;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (name.length === 0) continue;
		const rawSource = typeof entry.source === "string" ? entry.source : "";
		out.push({
			name,
			source: SNAPSHOT_SOURCES.has(rawSource) ? (rawSource as SectionSnapshot["source"]) : "absent",
			summary: typeof entry.summary === "string" ? entry.summary : "",
		});
	}
	return out;
}
