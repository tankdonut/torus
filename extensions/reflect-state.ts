/**
 * torus — per-session reflect state.
 *
 * Each session owns one JSON file under the per-project state dir
 * (`TORUS_HOME/state/--<project>--/reflect-state/`) recording when reflection
 * last settled for it. Reads are best-effort (missing or corrupt file →
 * zeros), writes are atomic, and nothing here touches the memory extension
 * (it links against this module, not the reverse).
 */

import path from "node:path";
import { projectStateDir, pruneOrphanSessionFiles, readJson, writeJson } from "./fsutil.js";
import { sessionFileExists } from "./sessions/index.js";

export interface ReflectState {
	lastReflectSettles: number;
	lastReflectAt: number;
}

const ZERO_STATE: ReflectState = { lastReflectSettles: 0, lastReflectAt: 0 };

/** Per-project dir, computed per call — the cwd can change between calls. */
export function reflectStateDir(): string {
	return path.join(projectStateDir(), "reflect-state");
}

export function reflectStatePath(sessionId: string): string {
	return path.join(reflectStateDir(), `${sessionId}.json`);
}

export function readReflectState(sessionId: string): ReflectState {
	return readJson<ReflectState>(reflectStatePath(sessionId), ZERO_STATE);
}

export function writeReflectState(sessionId: string, state: ReflectState): void {
	writeJson(reflectStatePath(sessionId), state);
}

/**
 * Orphan-only GC: a state file goes only when its session file is gone AND it
 * is older than `maxAgeMs` (a misconfiguration floor, never the primary
 * rule). Live-but-idle resumable sessions keep their counters forever, and an
 * unreadable sessions root (`exists` → null) prunes nothing.
 */
export function gcReflectState(
	maxAgeMs: number,
	now: number = Date.now(),
	exists: (sessionId: string) => boolean | null = (sessionId) => sessionFileExists(sessionId),
): number {
	return pruneOrphanSessionFiles(reflectStateDir(), exists, maxAgeMs, now);
}
