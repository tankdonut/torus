/**
 * torus automode — configuration: permission mode, rules file, model pin, audit log.
 *
 * Every function that touches disk or env takes its path/env as a parameter with
 * a real default, so callers (and tests) can point everything at a sandbox.
 * Parsing is best-effort by contract: config problems surface as warnings on the
 * returned object, never as throws — a broken config degrades to default mode
 * with an empty rules file, and the audit log never breaks execution.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
 * Root of torus user state: TORUS_HOME when set (the test suite points it at
 * an isolated root), else `.torus` under HOME, then os.homedir() — mirroring
 * fsutil's torusHome(). HOME wins over homedir() because bun's homedir() reads
 * the passwd entry and ignores $HOME (runtime/bin/torus.mjs resolves it the
 * same way).
 */
export function torusHomeDir(env: NodeJS.ProcessEnv = process.env): string {
	return env["TORUS_HOME"] || path.join(env["HOME"] || homedir(), ".torus");
}

/** Rules-file path under a torus home (defaults to the live process env). */
export function rulesPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(torusHomeDir(env), RULES_FILE_NAME);
}

/**
 * Audit-log path: the project state dir when the session provides one (every
 * torus session exports TORUS_STATE_DIR), else the torus home for bare pi
 * hosts. Rules stay user-global under the torus home so no project can widen
 * its own permissions.
 */
export function auditPath(env: NodeJS.ProcessEnv = process.env): string {
	return env["TORUS_STATE_DIR"]
		? path.join(env["TORUS_STATE_DIR"], AUDIT_LOG_NAME)
		: path.join(torusHomeDir(env), AUDIT_LOG_NAME);
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
 * Load the automode rules file. A missing file means "no rules" with no
 * warning; anything unreadable or unparseable also degrades to no rules, with
 * one warning per problem. Unknown top-level keys and non-array rule fields are
 * ignored with a warning; non-string entries inside a rule array are dropped
 * with a warning while the string entries are kept. `environment` and
 * `hardDeny` are prose string arrays for the decision model (trusted
 * infrastructure context and absolute boundaries); `classifyAllShell` is a
 * boolean that suspends allow rules while auto mode is active.
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

	const source = parsed as Record<string, unknown>;
	const warnings: string[] = [];
	const unknownKeys = Object.keys(source).filter(
		(key) => !(RULE_KEYS as readonly string[]).includes(key) && key !== "classifyAllShell",
	);
	if (unknownKeys.length > 0) {
		warnings.push(`${filePath}: ignoring unknown keys: ${unknownKeys.join(", ")}`);
	}

	const rules: AutomodeRulesFile = {};
	for (const key of RULE_KEYS) {
		if (!(key in source)) {
			continue;
		}
		const value = source[key];
		if (!Array.isArray(value)) {
			warnings.push(`${filePath}: "${key}" must be an array of strings; ignoring it`);
			continue;
		}
		const strings = value.filter((entry): entry is string => typeof entry === "string");
		const dropped = value.length - strings.length;
		if (dropped > 0) {
			warnings.push(
				`${filePath}: "${key}" contains ${dropped} non-string ${dropped === 1 ? "entry" : "entries"}; dropped`,
			);
		}
		rules[key] = strings;
	}
	if ("classifyAllShell" in source) {
		const value = source["classifyAllShell"];
		if (typeof value === "boolean") {
			rules.classifyAllShell = value;
		} else {
			warnings.push(`${filePath}: "classifyAllShell" must be a boolean; ignoring it`);
		}
	}
	return { rules, warnings };
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
