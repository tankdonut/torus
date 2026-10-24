/**
 * torus automode — configuration: permission mode, rules, model pin, audit log.
 *
 * Rules resolve through the unified config loader: the "automode" section of
 * config.json (same keys as the legacy file, validated the same way) wins over
 * automode.json, and neither configured means no rules. Path helpers derive
 * from fsutil's torusHome(), imported rather than mirrored, which reads the
 * live process env — callers and tests sandbox it via TORUS_HOME. Mode and
 * model-pin parsers take their env as a parameter with a real default.
 * Parsing is best-effort by contract: config problems surface as warnings on
 * the returned object, never as throws — a broken config degrades to default
 * mode with an empty rules file, and the audit log never breaks execution.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME, readSection } from "../config/loader.js";
import { torusHome } from "../fsutil.js";

export type PermissionMode = "default" | "auto";

/** Milliseconds a permission-classifier call may run before it is abandoned. */
export const CLASSIFY_TIMEOUT_MS = 15_000;

/** Classifier confidence below this falls back to asking the user. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Consecutive denies that trip the circuit breaker back to default mode. */
export const CIRCUIT_BREAKER_DENIES = 3;

export const RULES_FILE_NAME = "automode.json";
export const AUDIT_LOG_NAME = "automode.log";

/**
 * Rules-file path — the legacy automode.json, the canonical place rules lived
 * before the unified config (and the fallback when config.json has no
 * "automode" section). Derived from fsutil's torusHome() so every torus
 * consumer resolves the same root by construction, including the
 * TORUS_HOME=""-wins case under nullish coalescing.
 */
export function rulesPath(): string {
	return path.join(torusHome(), RULES_FILE_NAME);
}

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

/**
 * Permission mode from TORUS_PERMISSION_MODE: `1`/`on`/`auto` (case-insensitive)
 * select auto mode; unset, empty, `0`/`off`/`default` keep default mode. Any
 * other value falls back to default mode with a warning naming the bad value.
 */
export function resolveMode(env: { TORUS_PERMISSION_MODE?: string | undefined } = process.env): {
	mode: PermissionMode;
	warning?: string;
} {
	const raw = env["TORUS_PERMISSION_MODE"];
	if (raw === undefined) {
		return { mode: "default" };
	}
	const value = raw.trim().toLowerCase();
	if (AUTO_MODE_VALUES.has(value)) {
		return { mode: "auto" };
	}
	if (DEFAULT_MODE_VALUES.has(value)) {
		return { mode: "default" };
	}
	return {
		mode: "default",
		warning: `TORUS_PERMISSION_MODE=${raw} is not recognized; expected "1", "on", "auto" for auto mode or "0", "off", "default"/unset for default mode; using default mode`,
	};
}

export type AutomodeRulesFile = {
	allow?: string[];
	ask?: string[];
	deny?: string[];
	environment?: string[];
	hardDeny?: string[];
	classifyAllShell?: boolean;
};

const RULE_KEYS = ["allow", "ask", "deny", "environment", "hardDeny"] as const;

/**
 * Validate one parsed rules object — the same shape the legacy file carries
 * and the "automode" section of config.json holds. Unknown top-level keys and
 * non-array rule fields are ignored with a warning; non-string entries inside
 * a rule array are dropped with a warning while the string entries are kept.
 * `environment` and `hardDeny` are prose string arrays for the decision model
 * (trusted infrastructure context and absolute boundaries); `classifyAllShell`
 * is a boolean that suspends allow rules while auto mode is active. Every
 * warning is prefixed by `origin`, naming where the object came from: the
 * legacy file's path, or config.json for the unified config's section.
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

/**
 * Load the legacy automode rules file. A missing file means "no rules" with no
 * warning; anything unreadable or unparseable also degrades to no rules, with
 * one warning per problem. Key-level validation is shared with the unified
 * config's section through validateRulesObject.
 */
export function loadRules(filePath: string): { rules: AutomodeRulesFile; warnings: string[] } {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { rules: {}, warnings: [] };
		}
		return {
			rules: {},
			warnings: [`${filePath}: unreadable (${code ?? "unknown error"}); no rules loaded`],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { rules: {}, warnings: [`${filePath}: not valid JSON (${message}); no rules loaded`] };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { rules: {}, warnings: [`${filePath}: expected a JSON object; no rules loaded`] };
	}
	return validateRulesObject(parsed as Record<string, unknown>, filePath);
}

/** Where the effective automode rules came from. */
export type AutomodeRulesSource = "config.json" | "automode.json" | "default";

export type LoadedAutomodeRules = {
	rules: AutomodeRulesFile;
	warnings: string[];
	source: AutomodeRulesSource;
};

/**
 * Load the effective automode rules by precedence through the unified config
 * loader: the "automode" section of config.json (validated by the shared
 * validateRulesObject, warnings prefixed with config.json), then the legacy
 * automode.json exactly as loadRules serves it, then no rules. A section set
 * in both places yields exactly one deprecation warning pointing at
 * `torus config migrate`; a config.json that cannot be parsed falls back to
 * the legacy file with that failure as its own warning. Never throws.
 */
export function loadAutomodeRules(): LoadedAutomodeRules {
	const filePath = rulesPath();
	const section = readSection<Record<string, unknown>>("automode", {
		// The legacy loader answers "is there a legacy rules value?": a missing
		// file is no value at all, keeping the default tier distinguishable from
		// an existing (even empty) automode.json.
		load: () => (existsSync(filePath) ? loadRules(filePath).rules : undefined),
		sourceHint: RULES_FILE_NAME,
	});
	const warnings: string[] = section.warning === undefined ? [] : [section.warning];
	if (section.source === "config") {
		const validated = validateRulesObject(section.value ?? {}, CONFIG_FILE_NAME);
		return {
			rules: validated.rules,
			warnings: [...warnings, ...validated.warnings],
			source: CONFIG_FILE_NAME,
		};
	}
	// Legacy or default tier: serve loadRules directly so rules and warnings
	// are byte-identical to the pre-unified-config behavior.
	const loaded = loadRules(filePath);
	return {
		rules: loaded.rules,
		warnings: [...warnings, ...loaded.warnings],
		source: section.source === "legacy" ? RULES_FILE_NAME : "default",
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
