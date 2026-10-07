/**
 * torus — shared filesystem, formatting, and timing helpers.
 *
 * Every JSON read here is best-effort (missing or corrupt file → fallback);
 * every JSON write is atomic (tmp file + rename) with the parent directory
 * created on demand.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Parse `file` as JSON; any read/parse failure yields `fallback`. */
export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Atomically write `data` as pretty-printed JSON, creating parent dirs. */
export function writeJson(file: string, data: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmp, file);
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
