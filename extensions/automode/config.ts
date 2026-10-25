/**
 * torus automode — configuration: permission mode, rules, model pin, audit log.
 *
 * Rules come from the "automode" section of the unified config.json and
 * from nowhere else; no section means no rules. Path helpers derive from
 * fsutil's torusHome(), imported rather than mirrored, which reads the live
 * process env — callers and tests sandbox it via TORUS_HOME. Mode resolution
 * layers the config.json top-level "permissionMode" key under
 * TORUS_PERMISSION_MODE (a defined env value decides the tier outright), and
 * the mode and model-pin parsers take their env as a parameter with a real
 * default.
 * Parsing is best-effort by contract: config problems surface as warnings on
 * the returned object, never as throws — a broken config degrades to default
 * mode with no rules, and the audit log never breaks execution.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME, readSection } from "../config/loader.js";
import { torusHome } from "../fsutil.js";

export type PermissionMode = "default" | "auto" | "bypass";

/** Milliseconds a permission-classifier call may run before it is abandoned. */
export const CLASSIFY_TIMEOUT_MS = 15_000;

/** Classifier confidence below this falls back to asking the user. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Consecutive denies that trip the circuit breaker back to default mode. */
export const CIRCUIT_BREAKER_DENIES = 3;

export const AUDIT_LOG_NAME = "automode.log";

/**
 * Audit-log path: the project state dir when the session provides one (every
 * torus session exports TORUS_STATE_DIR), else the torus home for bare pi
 * hosts. Rules stay user-global under the torus home so no project can widen
 * its own permissions.
 */
export function auditPath(): string {
	return process.env["TORUS_STATE_DIR"]
		? path.join(process.env["TORUS_STATE_DIR"], AUDIT_LOG_NAME)
		: path.join(torusHome(), AUDIT_LOG_NAME);
}

const AUTO_MODE_VALUES = new Set(["1", "on", "auto"]);
const DEFAULT_MODE_VALUES = new Set(["", "0", "off", "default"]);

/** Which tier supplied the effective permission mode. */
export type PermissionModeSource = "env" | "config" | "default";

export type ModeResolution = {
	mode: PermissionMode;
	source: PermissionModeSource;
	warning?: string;
};

/**
 * Permission mode by full precedence: TORUS_PERMISSION_MODE (which the
 * --permission-mode launcher flag also sets) beats the top-level
 * "permissionMode" key of config.json beats "default". A defined env value
 * decides its tier outright, so env junk keeps default mode with a warning
 * and never falls through to a config value. A config value counts only when
 * it is exactly "auto" or "default"; "bypass" is refused with a warning
 * naming the startup-only switch (sessions must be launched with it, so it
 * can never be a sticky default), and anything else — including non-strings
 * — warns naming the value and is treated as unset. At most the deciding
 * tier warns. permissionMode is user-level only by construction: config.json
 * lives under the torus home (TORUS_HOME||~/.torus), so a repo checkout can
 * never set it for a session.
 */
export function resolveModeSource(
	env: { TORUS_PERMISSION_MODE?: string | undefined } = process.env,
	configMode?: unknown,
): ModeResolution {
	const raw = env["TORUS_PERMISSION_MODE"];
	if (raw !== undefined) {
		const value = raw.trim().toLowerCase();
		if (AUTO_MODE_VALUES.has(value)) return { mode: "auto", source: "env" };
		if (DEFAULT_MODE_VALUES.has(value)) return { mode: "default", source: "env" };
		if (value === "bypass") return { mode: "bypass", source: "env" };
		return {
			mode: "default",
			source: "env",
			warning: `TORUS_PERMISSION_MODE=${raw} is not recognized; expected "1", "on", "auto" for auto mode, "bypass" for bypass mode, or "0", "off", "default"/unset for default mode; using default mode`,
		};
	}
	if (configMode !== undefined) {
		if (configMode === "auto") return { mode: "auto", source: "config" };
		if (configMode === "default") return { mode: "default", source: "config" };
		if (configMode === "bypass") {
			return {
				mode: "default",
				source: "config",
				warning:
					'permissionMode="bypass" is refused: bypass is startup-only — launch each session with torus --permission-mode bypass (or TORUS_PERMISSION_MODE=bypass); using default mode',
			};
		}
		return {
			mode: "default",
			source: "config",
			warning: `permissionMode=${JSON.stringify(configMode)} is not recognized; expected "auto" or "default"; using default mode`,
		};
	}
	return { mode: "default", source: "default" };
}

/**
 * Permission mode with the same env-over-config precedence as
 * resolveModeSource, in the two-field shape callers that do not care which
 * tier decided have always consumed.
 */
export function resolveMode(
	env: { TORUS_PERMISSION_MODE?: string | undefined } = process.env,
	configMode?: unknown,
): {
	mode: PermissionMode;
	warning?: string;
} {
	const { mode, warning } = resolveModeSource(env, configMode);
	return warning === undefined ? { mode } : { mode, warning };
}

/**
 * True when the session started in bypass mode. Guard extensions call this
 * once, at registration time: the env is fixed for the engine's lifetime
 * (the launcher sets it at spawn), so bypass is startup-only by construction —
 * no slash command, config write, or tool call can flip it mid-session.
 */
export function isBypassMode(
	env: { TORUS_PERMISSION_MODE?: string | undefined } = process.env,
): boolean {
	return (env["TORUS_PERMISSION_MODE"] ?? "").trim().toLowerCase() === "bypass";
}

export type AutomodeRulesFile = {
	allow?: string[];
	ask?: string[];
	deny?: string[];
	environment?: string[];
	softDeny?: string[];
	softDenyExceptions?: string[];
	hardDeny?: string[];
	classifyAllShell?: boolean;
};

const RULE_KEYS = [
	"allow",
	"ask",
	"deny",
	"environment",
	"softDeny",
	"softDenyExceptions",
	"hardDeny",
] as const;

/**
 * Validate one parsed rules object — the shape the "automode" section of
 * config.json holds. Unknown top-level keys and non-array rule fields are
 * ignored with a warning; non-string entries inside a rule array are dropped
 * with a warning while the string entries are kept. `environment`,
 * `softDeny`, `softDenyExceptions`, and `hardDeny` are prose string arrays
 * for the decision model (trusted infrastructure context, soft boundaries
 * the judge may clear via an exception or specific recent intent, their
 * exceptions, and absolute boundaries); `classifyAllShell` is a boolean
 * that suspends allow rules while auto mode is active. Every warning is
 * prefixed by `origin`, naming where the object came from (config.json for
 * the unified config's section).
 */
export function validateRulesObject(
	source: Record<string, unknown>,
	origin: string,
): { rules: AutomodeRulesFile; warnings: string[] } {
	const warnings: string[] = [];
	const unknownKeys = Object.keys(source).filter(
		(key) => !(RULE_KEYS as readonly string[]).includes(key) && key !== "classifyAllShell",
	);
	if (unknownKeys.length > 0) {
		warnings.push(`${origin}: ignoring unknown keys: ${unknownKeys.join(", ")}`);
	}

	const rules: AutomodeRulesFile = {};
	for (const key of RULE_KEYS) {
		if (!(key in source)) {
			continue;
		}
		const value = source[key];
		if (!Array.isArray(value)) {
			warnings.push(`${origin}: "${key}" must be an array of strings; ignoring it`);
			continue;
		}
		const strings = value.filter((entry): entry is string => typeof entry === "string");
		const dropped = value.length - strings.length;
		if (dropped > 0) {
			warnings.push(
				`${origin}: "${key}" contains ${dropped} non-string ${dropped === 1 ? "entry" : "entries"}; dropped`,
			);
		}
		rules[key] = strings;
	}
	if ("classifyAllShell" in source) {
		const value = source["classifyAllShell"];
		if (typeof value === "boolean") {
			rules.classifyAllShell = value;
		} else {
			warnings.push(`${origin}: "classifyAllShell" must be a boolean; ignoring it`);
		}
	}
	return { rules, warnings };
}

/** Where the effective automode rules came from. */
export type AutomodeRulesSource = "config.json" | "default";

export type LoadedAutomodeRules = {
	rules: AutomodeRulesFile;
	warnings: string[];
	source: AutomodeRulesSource;
};

/**
 * Load the effective automode rules: the "automode" section of config.json,
 * validated by validateRulesObject (its warnings prefixed with config.json).
 * No section means no rules; a config that cannot be parsed contributes its
 * own warning and resolves to no rules. Never throws.
 */
export function loadAutomodeRules(): LoadedAutomodeRules {
	const section = readSection<Record<string, unknown>>("automode");
	const warnings: string[] = section.warning === undefined ? [] : [section.warning];
	if (section.value === undefined) {
		return { rules: {}, warnings, source: "default" };
	}
	const validated = validateRulesObject(section.value, CONFIG_FILE_NAME);
	return {
		rules: validated.rules,
		warnings: [...warnings, ...validated.warnings],
		source: CONFIG_FILE_NAME,
	};
}

/**
 * Model pin from TORUS_PERMISSION_MODEL (`provider/model-id`). Unset or empty
 * means "no pin" with no warning; a malformed value yields no pin plus a
 * warning the caller must surface.
 */
export function parseModelPin(env: { TORUS_PERMISSION_MODEL?: string | undefined } = process.env): {
	pin?: { provider: string; modelId: string };
	warning?: string;
} {
	const raw = env["TORUS_PERMISSION_MODEL"];
	if (raw === undefined || raw.trim() === "") {
		return {};
	}
	const value = raw.trim();
	const slash = value.indexOf("/");
	if (slash === -1) {
		return malformedPinWarning(raw);
	}
	const provider = value.slice(0, slash);
	const modelId = value.slice(slash + 1);
	if (provider === "" || modelId === "") {
		return malformedPinWarning(raw);
	}
	return { pin: { provider, modelId } };
}

function malformedPinWarning(raw: string): { warning: string } {
	return {
		warning: `TORUS_PERMISSION_MODEL=${raw} is malformed; expected "provider/model-id"; ignoring model pin`,
	};
}

/** One automode decision, as written to the append-only audit log. */
export type AuditRow = {
	ts: number;
	mode: PermissionMode;
	source: string;
	verdict: string;
	reason: string;
	model?: string;
	confidence?: number;
	ms?: number;
	command: string;
};

/**
 * Append one JSON line to the audit log, creating parent directories on demand.
 * Every failure is swallowed: auditing must never break the permission flow.
 */
export function appendAuditRow(row: AuditRow, logPath: string = auditPath()): void {
	try {
		mkdirSync(path.dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(row)}\n`);
	} catch {
		// Audit is best-effort by contract.
	}
}
