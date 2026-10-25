/**
 * torus config — typed knob readers over the unified config file.
 *
 * One call per tunable resolves env-over-config-over-default and returns just
 * the value; callers keep their historical truth rules via the optional
 * `parse` hook (the classic "<VAR>=0 disables" vars pass parseZeroDisables so
 * every other defined value still means on). Knobs are silent and cheap: a
 * config value of the wrong type is ignored without warning, and
 * loadConfigFile's own tolerance (missing or malformed file → empty config)
 * carries through, so a knob call never throws and never blocks startup.
 *
 * Section and key names are knob-local (`ui.banner`, `guards.maxToolOutput`,
 * ...); they need no entry in sections.ts, which only registers sections with
 * a `torus config status|migrate` surface. `parsed` follows readSection's
 * convention: pass a preloaded config on hot paths to skip the file read.
 */

import { configOverEnv, loadConfigFile, loadProjectConfig, parseEnvBoolean } from "./loader.js";

/**
 * Env-string parse hook: return the resolved value, or undefined to treat the
 * variable as unset and fall through to config.
 */
export type KnobParse<T> = (raw: string) => T | undefined;

/**
 * Parse for the classic "<VAR>=0 disables" knobs: every other defined value —
 * including "" and unparseable strings — enables, matching the historical
 * strict `=== "0"` reads these knobs replace.
 */
export function parseZeroDisables(raw: string): boolean {
	return raw !== "0";
}

/**
 * One key out of one config section: a missing section, a non-object section,
 * or a missing key all mean "no config value". Wrong-typed values are the
 * caller's filter — each knob* ignores what its type check rejects.
 */
function sectionValue(section: string, key: string, parsed?: Record<string, unknown>): unknown {
	const config = parsed ?? loadConfigFile().config;
	const holder = config[section];
	if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return undefined;
	if (!Object.hasOwn(holder, key)) return undefined;
	return (holder as Record<string, unknown>)[key];
}

/**
 * Same lookup against the project-level config (already allowlist-filtered
 * by loadProjectConfig, so only knob sections can carry values here). Knobs
 * are silent: the project file's refused-keys warning surfaces through the
 * automode startup notice and `torus config status`, not per knob call.
 */
function projectSectionValue(
	section: string,
	key: string,
	projectParsed?: Record<string, unknown>,
): unknown {
	const config = projectParsed ?? loadProjectConfig().config;
	const holder = config[section];
	if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return undefined;
	if (!Object.hasOwn(holder, key)) return undefined;
	return (holder as Record<string, unknown>)[key];
}

/**
 * Boolean knob (env > user config.json > project config > fallback). The
 * default env parse is parseEnvBoolean ("0"/"false"/"1"/"true" only); pass a
 * custom parse to preserve other historical env reads. A non-boolean config
 * value on either tier is ignored, falling back to the default.
 */
export function knobBoolean(
	envName: string,
	section: string,
	key: string,
	fallback: boolean,
	parse?: KnobParse<boolean>,
	parsed?: Record<string, unknown>,
	projectParsed?: Record<string, unknown>,
): boolean {
	const raw = process.env[envName];
	const envValue = raw === undefined ? undefined : (parse ?? parseEnvBoolean)(raw);
	const candidate = sectionValue(section, key, parsed);
	let configValue = typeof candidate === "boolean" ? candidate : undefined;
	if (configValue === undefined) {
		const projectCandidate = projectSectionValue(section, key, projectParsed);
		configValue = typeof projectCandidate === "boolean" ? projectCandidate : undefined;
	}
	return configOverEnv(envValue, configValue, fallback).value;
}

/**
 * String knob (env > user config.json > project config > fallback). Any
 * defined env value — including "" — wins, matching the direct process.env
 * reads these knobs replace (consumers treat "" themselves). A non-string
 * config value on either tier is ignored, falling back to the default.
 */
export function knobString(
	envName: string,
	section: string,
	key: string,
	fallback: string,
	parsed?: Record<string, unknown>,
	projectParsed?: Record<string, unknown>,
): string {
	const envValue = process.env[envName];
	const candidate = sectionValue(section, key, parsed);
	let configValue = typeof candidate === "string" ? candidate : undefined;
	if (configValue === undefined) {
		const projectCandidate = projectSectionValue(section, key, projectParsed);
		configValue = typeof projectCandidate === "string" ? projectCandidate : undefined;
	}
	return configOverEnv(envValue, configValue, fallback).value;
}

/**
 * Number knob (env > user config.json > project config > fallback). The
 * default env parse is Number, preserving the old `Number(process.env[X])`
 * idiom: an unparseable env value resolves to NaN and still wins over config,
 * so consumers keep their own NaN clamping. A config value that is not a
 * finite number (JSON cannot carry NaN or Infinity, but strings and booleans
 * arrive as such) on either tier is ignored, falling back to the default.
 */
export function knobNumber(
	envName: string,
	section: string,
	key: string,
	fallback: number,
	parse?: KnobParse<number>,
	parsed?: Record<string, unknown>,
	projectParsed?: Record<string, unknown>,
): number {
	const raw = process.env[envName];
	const envValue = raw === undefined ? undefined : (parse ?? Number)(raw);
	const candidate = sectionValue(section, key, parsed);
	let configValue =
		typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
	if (configValue === undefined) {
		const projectCandidate = projectSectionValue(section, key, projectParsed);
		configValue =
			typeof projectCandidate === "number" && Number.isFinite(projectCandidate)
				? projectCandidate
				: undefined;
	}
	return configOverEnv(envValue, configValue, fallback).value;
}
