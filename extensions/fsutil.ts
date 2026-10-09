/**
 * torus — shared filesystem, formatting, and timing helpers.
 *
 * Every JSON read here is best-effort (missing or corrupt file → fallback);
 * every JSON write is atomic (tmp file + rename) with the parent directory
 * created on demand.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Root of torus user state. `TORUS_HOME` overrides the default `~/.torus` —
 * the test suite points it at a temp sandbox so planted beacons, logs, and
 * memory fixtures never touch real user state.
 */
export function torusHome(): string {
	return process.env["TORUS_HOME"] ?? path.join(homedir(), ".torus");
}

/**
 * Canonical project identity for filesystem layout, mirroring pi's session
 * directory scheme (docs/session-format.md): absolute cwd with "/"→"-",
 * wrapped in "--". Memory's frontmatter `project:` values intentionally stay
 * on their own slug (stable stored data), so this key is the only
 * directory-level project identity.
 */
export function projectKey(cwd: string): string {
	return `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;
}

/**
 * Per-project state root: ${TORUS_HOME:-~/.torus}/state/--<project>--/.
 *
 * Called without `cwd` this also mirrors the result into the environment as
 * TORUS_STATE_DIR (see TORUS_STATE_DIR_ENV) — the value prompts and shell
 * commands should use instead of hand-deriving the dashed project key.
 *
 * Resolution: engine children (TORUS_ENGINE_CHILD=1, set by engineChildEnv)
 * treat the inherited value as authoritative — the dispatching session pinned
 * them to its root, so `$TORUS_STATE_DIR/…` paths and ledger appends land in
 * the dispatching project even from a worktree cwd. Main sessions recompute
 * from cwd on every call (a stale value never survives). Explicit-cwd calls
 * (child-log keying, sandbox hosts) always compute fresh and never touch the
 * env.
 */
export function projectStateDir(cwd?: string): string {
	if (cwd === undefined && process.env["TORUS_ENGINE_CHILD"] === "1") {
		const pinned = process.env[TORUS_STATE_DIR_ENV];
		if (pinned !== undefined && pinned.length > 0) return pinned;
	}
	const dir = path.join(torusHome(), "state", projectKey(cwd ?? process.cwd()));
	if (cwd === undefined) process.env[TORUS_STATE_DIR_ENV] = dir;
	return dir;
}

/**
 * Env var carrying this process's per-project state root. Exported in every
 * torus process — main session, delegated engine children, team members — so
 * tool descriptions, skills, and bash commands reference `$TORUS_STATE_DIR/…`
 * instead of `~/.torus/state/--<dashed-cwd>--/…` (long, and hand-deriving the
 * key has caused misfiled plans). Children inherit the parent's value through
 * `engineChildEnv()` and keep it (pinned — see projectStateDir), so a
 * `$TORUS_STATE_DIR` path in a dispatch text means the dispatching project's
 * root no matter which cwd the child runs in.
 */
export const TORUS_STATE_DIR_ENV = "TORUS_STATE_DIR";

/** (Re)export TORUS_STATE_DIR from this process's cwd; returns the value. */
export function ensureStateDirEnv(): string {
	return projectStateDir();
}

/**
 * Display form of a torus-owned path for tool output and prompts: this
 * process's state root renders as `$TORUS_STATE_DIR/…` (copy-pasteable — the
 * var is exported, so it expands in shell commands), any other TORUS_HOME path
 * as `$TORUS_HOME/…`, anything else unchanged. Never affects paths on disk.
 */
export function displayPath(file: string): string {
	const state = projectStateDir();
	if (file === state || file.startsWith(`${state}${path.sep}`)) {
		return file.replace(state, () => `$${TORUS_STATE_DIR_ENV}`);
	}
	const home = torusHome();
	if (file === home || file.startsWith(`${home}${path.sep}`)) {
		return file.replace(home, () => "$TORUS_HOME");
	}
	return file;
}

// Exported at module load so every torus process — main session, delegated
// children, team members (all load extensions that import this module) —
// carries $TORUS_STATE_DIR from its first turn; later projectStateDir() calls
// keep it fresh.
ensureStateDirEnv();

/** Parse `file` as JSON; any read/parse failure yields `fallback`. */
export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/**
 * Read `file` as JSON, falling back to `legacyFile` only when `file` does not
 * exist — a present-but-null `file` wins (cleared state must not resurrect
 * from a stale legacy twin).
 */
export function readJsonFallback<T>(file: string, legacyFile: string, fallback: T): T {
	if (existsSync(file)) return readJson<T>(file, fallback);
	return readJson<T>(legacyFile, fallback);
}

/** Atomically write `data` as pretty-printed JSON, creating parent dirs. */
export function writeJson(file: string, data: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmp, file);
}

/** Deduped basename union of two directories (missing dirs contribute nothing). */
export function listDirUnion(newDir: string, legacyDir: string): string[] {
	const names = new Set<string>();
	for (const dir of [newDir, legacyDir]) {
		try {
			for (const entry of readdirSync(dir)) names.add(entry);
		} catch {}
	}
	return [...names];
}

/**
 * Orphan-only GC for session-keyed `<sessionId>.json` state files: delete only
 * when `exists` reports `false` (session file gone) AND the file is older than
 * `minAgeMs` (misconfiguration guard — age is never the primary rule).
 * `true` (session live) and `null` (sessions root unreadable) both keep
 * everything; best-effort, returns the number of files removed.
 */
export function pruneOrphanSessionFiles(
	dir: string,
	exists: (sessionId: string) => boolean | null,
	minAgeMs: number,
	now: number = Date.now(),
): number {
	let removed = 0;
	try {
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".json")) continue;
			const file = path.join(dir, entry);
			try {
				if (now - statSync(file).mtimeMs <= minAgeMs) continue;
				if (exists(entry.slice(0, -".json".length)) !== false) continue;
				unlinkSync(file);
				removed += 1;
			} catch {}
		}
	} catch {}
	return removed;
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a comma-separated list, trimming and dropping empty entries. */
export function splitList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Format an engine-computed dollar cost for delegation surfaces.
 *
 * - Absent or non-finite cost → "" (no cost data; the surface renders nothing)
 * - Negative cost → "" (not a price signal; engine totals are ≥ 0, defensive)
 * - Exactly 0 with tokens spent → "$0" (the run happened but the model has
 *   no catalog price; an explicit zero beats an ambiguous blank)
 * - Exactly 0 with no tokens → "" (nothing measurable happened)
 * - Under $1 keeps 4 decimal places; $1 and above trims to 2
 */
export function formatCost(cost: number | undefined, tokensSpent: boolean): string {
	if (typeof cost !== "number" || !Number.isFinite(cost)) return "";
	if (cost < 0) return "";
	if (cost === 0) return tokensSpent ? "$0" : "";
	if (Math.abs(cost) >= 1) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(4)}`;
}
