/**
 * torus — incognito-mode core.
 *
 * Incognito runs memoryless: no dream consolidation, no idle reflection, no
 * tool-call reflection, and every trace under the project state dir is swept
 * on exit. The child-session transcript is the one artifact NOT removed: pi
 * rewrites it on every turn, so deleting it mid-run corrupts the session, and
 * the state-dir child-sessions layout keeps it out of pi's default /resume
 * tree (resumable only with an explicit `--session-dir` pointing at it).
 *
 * Pure helpers, no side effects, so the launcher's plain-node flag extractor
 * and every extension share one definition of what incognito means.
 */

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { projectStateDir } from "./fsutil.js";

export const INCOGNITO_ENV = "TORUS_INCOGNITO";
export const INCOGNITO_FLAG = "--incognito";

/**
 * Is this process running incognito? Env wins (the launcher sets it from the
 * CLI flag so the flag and a pre-exported variable mean the same session), a
 * flag in argv wins for direct engine runs the launcher never sees.
 */
export function incognitoActive(argv: readonly string[] = []): boolean {
	if ((process.env[INCOGNITO_ENV] ?? "") === "1") return true;
	return argv.includes(INCOGNITO_FLAG);
}

/**
 * Every torus-written directory under the project state dir swept on exit.
 * Delegation logs (the fleet transcript tee), monitor history, background
 * task output, reflect-state counters, plans, work ledgers, goal files,
 * todos, and the undelivered wake spool (whose markers carry result tails a
 * later session would flush): pi's session-search tools read the rest, so
 * leaving any of those behind leaves the session's activity searchable.
 */
export function incognitoSweepTargets(stateDir: string = projectStateDir()): string[] {
	return [
		"logs",
		"monitors",
		"bg",
		"reflect-state",
		"plans",
		"work",
		"goal",
		"todo",
		"wake-spool",
	].map((name) => path.join(stateDir, name));
}

/**
 * Remove every sweep target. Independent best-effort removals: one failing
 * target never blocks the rest, and the caller reports what survived.
 */
export function incognitoSweep(stateDir: string = projectStateDir()): string[] {
	const survivors: string[] = [];
	for (const target of incognitoSweepTargets(stateDir)) {
		try {
			rmSync(target, { recursive: true, force: true });
		} catch {
			survivors.push(target);
		}
	}
	return survivors;
}

/**
 * Which child-session transcripts (delegation/team/RPC children and this
 * parent's own engine children) still exist under the state dir. Sweeping
 * those is separate: parents delete them per-run as each child exits; a
 * sweep would corrupt any live child's transcript, so nothing else is
 * deleted here.
 */
export function childSessionPaths(stateDir: string = projectStateDir()): string[] {
	try {
		return readdirSync(path.join(stateDir, "child-sessions")).map((name) =>
			path.join(stateDir, "child-sessions", name),
		);
	} catch {
		return [];
	}
}
