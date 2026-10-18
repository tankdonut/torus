/**
 * torus — sandbox policy layer.
 *
 * File-based sandbox configuration read from pi settings files, layered under
 * the env-only knobs handled in ./index.ts:
 *
 *   - user layer: $PI_CODING_AGENT_DIR ?? ~/.pi/agent/settings.json (always read)
 *   - project layer: <cwd>/.pi/settings.json (read only for trusted projects)
 *
 * The policy lives under "torus" → "sandbox" inside those files; everything
 * else in them is ignored. The project layer is additive-only: it may
 * contribute writable roots, hosts.add, hosts.deny, env, and sign.relay, but
 * never mode, exempt, hosts.only, or credentials — a committed file must not
 * be able to weaken the sandbox, so those keys are dropped with a notice
 * naming the key and the file (repo-poisoning defense). Env precedence
 * (env > user > project) is the caller's wiring; this module never reads
 * process.env beyond the documented user-settings-path resolution. Notices
 * are returned, never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseNetEntries, type SandboxMode } from "./index.js";

/** Raw policy as it appears under torus.sandbox in a settings file. */
export type SandboxPolicy = {
	mode?: "off" | "full";
	writable?: string[];
	hosts?: { add?: string[]; only?: string[]; deny?: string[] };
	credentials?: { files?: string[]; envVars?: string[] };
	exempt?: string[];
	env?: Record<string, string>;
	sign?: { relay?: boolean };
};

/**
 * Writable-root entry in srt 0.0.80's allowWrite shape (FilesystemConfig
 * accepts `string | { path; literal: true }` per entry). srt treats plain
 * strings as glob patterns and drops fragile ones on Linux, so every
 * policy-provided root is emitted as a literal path entry — deliberate
 * simplification from "literal only for paths with metacharacters": policy
 * writable paths are concrete roots, and literal emission is uniformly safe.
 * Ready to spread straight into `filesystem.allowWrite`.
 */
export type SandboxWritableRoot = { path: string; literal: true };

/** Fully materialized policy: every list is present (empty when unset). */
export type ResolvedSandboxPolicy = {
	/** Mode the user layer requested; undefined when it did not (the env layer decides). */
	mode: SandboxMode | undefined;
	/** Literal allowWrite entries: user roots first, then trusted project roots, deduped. */
	writable: SandboxWritableRoot[];
	/** Host additions on top of the curated allowlist. */
	hostsAdd: string[];
	/** Replacement allowlist (user layer only; projects cannot set it). */
	hostsOnly: string[];
	/** Denied hosts. */
	hostsDeny: string[];
	/** Credential files to mask (user layer only; projects cannot set credentials). */
	credentialsFiles: string[];
	/** Credential env vars to mask (user layer only; projects cannot set credentials). */
	credentialsEnvVars: string[];
	/** Commands exempt from sandboxing (user layer only; projects cannot set it). */
	exempt: string[];
	/** Env vars to set inside the sandbox; project keys never shadow user keys. */
	env: Record<string, string>;
	/** Whether to relay signed-commit credentials into the sandbox. */
	signRelay: boolean;
};

export interface LoadSandboxPolicyOptions {
	/** Trust gate for the project layer; defaults to "not trusted". */
	isProjectTrusted?: () => boolean;
	/** Overrides the user settings path (for tests). */
	userSettingsPath?: string;
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Default user settings path, resolved the way the doctor extension does. */
export function defaultUserSettingsPath(): string {
	const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

/**
 * Reads and parses a settings file. Absent → undefined (silent); malformed or
 * unreadable → notice + undefined. Returns the parsed JSON, unvalidated.
 */
function readSettingsJson(file: string, notices: string[]): unknown {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		notices.push(
			`[torus: sandbox] could not read ${file}: ${reason(error)} — sandbox policy ignored`,
		);
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		notices.push(
			`[torus: sandbox] could not parse ${file}: ${reason(error)} — sandbox policy ignored`,
		);
		return undefined;
	}
}

/** Extracts torus.sandbox as a record; anything else (or absent) → undefined. */
function policyRecord(settings: unknown): Record<string, unknown> | undefined {
	if (!isRecord(settings)) return undefined;
	const torus = settings["torus"];
	if (!isRecord(torus)) return undefined;
	const sandbox = torus["sandbox"];
	if (!isRecord(sandbox)) return undefined;
	return sandbox;
}

function stringList(
	value: unknown,
	key: string,
	file: string,
	notices: string[],
): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		notices.push(
			`[torus: sandbox] ${file}: torus.sandbox.${key} must be an array of strings — ignored`,
		);
		return undefined;
	}
	return value;
}

function booleanFlag(
	value: unknown,
	key: string,
	file: string,
	notices: string[],
): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		notices.push(`[torus: sandbox] ${file}: torus.sandbox.${key} must be a boolean — ignored`);
		return undefined;
	}
	return value;
}

function sanitizeEnv(
	value: unknown,
	file: string,
	notices: string[],
): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		notices.push(
			`[torus: sandbox] ${file}: torus.sandbox.env must be an object of string values — ignored`,
		);
		return undefined;
	}
	const env: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			notices.push(
				`[torus: sandbox] ${file}: torus.sandbox.env["${key}"] must be a string — ignored`,
			);
			continue;
		}
		env[key] = entry;
	}
	return env;
}

/** Validates everything the user layer may set. */
function sanitizeUserPolicy(
	raw: Record<string, unknown>,
	file: string,
	notices: string[],
): SandboxPolicy {
	const policy: SandboxPolicy = {};
	const mode = raw["mode"];
	if (mode !== undefined && mode !== null) {
		if (mode === "off" || mode === "full") policy.mode = mode;
		else
			notices.push(
				`[torus: sandbox] ${file}: torus.sandbox.mode must be "off" or "full" — ignored`,
			);
	}
	const writable = stringList(raw["writable"], "writable", file, notices);
	if (writable) policy.writable = writable;
	if (isRecord(raw["hosts"])) {
		const add = stringList(raw["hosts"]["add"], "hosts.add", file, notices);
		const only = stringList(raw["hosts"]["only"], "hosts.only", file, notices);
		const deny = stringList(raw["hosts"]["deny"], "hosts.deny", file, notices);
		if (add || only || deny) {
			policy.hosts = {
				...(add ? { add } : {}),
				...(only ? { only } : {}),
				...(deny ? { deny } : {}),
			};
		}
	}
	if (isRecord(raw["credentials"])) {
		const files = stringList(raw["credentials"]["files"], "credentials.files", file, notices);
		const envVars = stringList(raw["credentials"]["envVars"], "credentials.envVars", file, notices);
		if (files || envVars) {
			policy.credentials = { ...(files ? { files } : {}), ...(envVars ? { envVars } : {}) };
		}
	}
	const exempt = stringList(raw["exempt"], "exempt", file, notices);
	if (exempt) policy.exempt = exempt;
	const env = sanitizeEnv(raw["env"], file, notices);
	if (env) policy.env = env;
	if (isRecord(raw["sign"])) {
		const relay = booleanFlag(raw["sign"]["relay"], "sign.relay", file, notices);
		if (relay !== undefined) policy.sign = { relay };
	}
	return policy;
}

const POISON_NOTICE = "— ignored (a committed file cannot weaken the sandbox)";

/** Validates the additive-only subset the project layer may set; drops the rest. */
function sanitizeProjectPolicy(
	raw: Record<string, unknown>,
	file: string,
	notices: string[],
): SandboxPolicy {
	const additions: SandboxPolicy = {};
	for (const key of ["mode", "exempt", "credentials"] as const) {
		if (raw[key] !== undefined && raw[key] !== null) {
			notices.push(
				`[torus: sandbox] ${file}: project settings cannot set torus.sandbox.${key} ${POISON_NOTICE}`,
			);
		}
	}
	const writable = stringList(raw["writable"], "writable", file, notices);
	if (writable) additions.writable = writable;
	if (isRecord(raw["hosts"])) {
		if (raw["hosts"]["only"] !== undefined && raw["hosts"]["only"] !== null) {
			notices.push(
				`[torus: sandbox] ${file}: project settings cannot set torus.sandbox.hosts.only ${POISON_NOTICE}`,
			);
		}
		const add = stringList(raw["hosts"]["add"], "hosts.add", file, notices);
		const deny = stringList(raw["hosts"]["deny"], "hosts.deny", file, notices);
		if (add || deny) additions.hosts = { ...(add ? { add } : {}), ...(deny ? { deny } : {}) };
	}
	const env = sanitizeEnv(raw["env"], file, notices);
	if (env) additions.env = env;
	if (isRecord(raw["sign"])) {
		const relay = booleanFlag(raw["sign"]["relay"], "sign.relay", file, notices);
		if (relay !== undefined) additions.sign = { relay };
	}
	return additions;
}

/** Runs host entries through the shared net-entry parser, noticing dropped patterns. */
function hostList(entries: string[] | undefined, file: string, notices: string[]): string[] {
	if (!entries || entries.length === 0) return [];
	const parsed = parseNetEntries(entries.join(","));
	for (const dropped of parsed.dropped) {
		notices.push(`[torus: sandbox] dropped over-broad host pattern "${dropped}" from ${file}`);
	}
	return parsed.entries;
}

function dedup<T>(items: T[]): T[] {
	return [...new Set(items)];
}

export function loadSandboxPolicy(
	cwd: string,
	opts: LoadSandboxPolicyOptions = {},
): { policy: ResolvedSandboxPolicy; notices: string[] } {
	const notices: string[] = [];
	const userFile = opts.userSettingsPath ?? defaultUserSettingsPath();
	const projectFile = path.resolve(cwd, ".pi", "settings.json");

	const userRecord = policyRecord(readSettingsJson(userFile, notices));
	const user = userRecord ? sanitizeUserPolicy(userRecord, userFile, notices) : {};

	let project: SandboxPolicy = {};
	if (opts.isProjectTrusted?.() ?? false) {
		const projectRecord = policyRecord(readSettingsJson(projectFile, notices));
		project = projectRecord ? sanitizeProjectPolicy(projectRecord, projectFile, notices) : {};
	}

	// User layer first, project additions appended; dedup preserves first occurrence.
	const writablePaths = dedup(
		[...(user.writable ?? []), ...(project.writable ?? [])]
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
	);

	const env: Record<string, string> = { ...(project.env ?? {}), ...(user.env ?? {}) };
	for (const key of Object.keys(project.env ?? {})) {
		if (key in (user.env ?? {})) {
			notices.push(
				`[torus: sandbox] ${projectFile}: project settings cannot override env "${key}" set by user settings — ignored`,
			);
		}
	}

	const policy: ResolvedSandboxPolicy = {
		mode: user.mode,
		writable: writablePaths.map((entry) => ({ path: entry, literal: true })),
		hostsAdd: dedup([
			...hostList(user.hosts?.add, userFile, notices),
			...hostList(project.hosts?.add, projectFile, notices),
		]),
		hostsOnly: dedup(hostList(user.hosts?.only, userFile, notices)),
		hostsDeny: dedup([
			...hostList(user.hosts?.deny, userFile, notices),
			...hostList(project.hosts?.deny, projectFile, notices),
		]),
		credentialsFiles: dedup(user.credentials?.files ?? []),
		credentialsEnvVars: dedup(user.credentials?.envVars ?? []),
		exempt: dedup(user.exempt ?? []),
		env,
		signRelay: user.sign?.relay ?? project.sign?.relay ?? false,
	};
	return { policy, notices };
}
