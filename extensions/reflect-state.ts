/**
 * torus — per-session reflect state.
 *
 * Each session owns one JSON file under the per-project state dir
 * (`TORUS_HOME/state/--<project>--/reflect-state/`) recording when reflection
 * last settled for it. Reads fall back to the flat pre-projectization
 * `TORUS_HOME/reflect-state/` twin until a write migrates it away. Reads are
 * best-effort (missing or corrupt file → zeros), writes are atomic, and
 * nothing here touches the memory extension (it links against this module,
 * not the reverse).
 */

import { unlinkSync } from "node:fs";
import path from "node:path";
import {
	projectStateDir,
	pruneOrphanSessionFiles,
	readJsonFallback,
	torusHome,
	writeJson,
} from "./fsutil.js";
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

/** Pre-projectization dir — read fallback only, never written or pruned. */
function legacyReflectStatePath(sessionId: string): string {
	return path.join(torusHome(), "reflect-state", `${sessionId}.json`);
}

export function reflectStatePath(sessionId: string): string {
	return path.join(reflectStateDir(), `${sessionId}.json`);
}

export function readReflectState(sessionId: string): ReflectState {
	return readJsonFallback<ReflectState>(
		reflectStatePath(sessionId),
		legacyReflectStatePath(sessionId),
		ZERO_STATE,
	);
}

export function writeReflectState(sessionId: string, state: ReflectState): void {
	writeJson(reflectStatePath(sessionId), state);
	try {
		unlinkSync(legacyReflectStatePath(sessionId));
	} catch {}
}

/**
 * Orphan-only GC: a state file goes only when its session file is gone AND it
 * is older than `maxAgeMs` (a misconfiguration floor, never the primary
 * rule). Live-but-idle resumable sessions keep their counters forever, an
 * unreadable sessions root (`exists` → null) prunes nothing, and the legacy
 * dir is never scanned.
 */
export function gcReflectState(
	maxAgeMs: number,
	now: number = Date.now(),
	exists: (sessionId: string) => boolean | null = (sessionId) => sessionFileExists(sessionId),
): number {
	return pruneOrphanSessionFiles(reflectStateDir(), exists, maxAgeMs, now);
}

export function unlinkLegacyReflectState(): boolean {
	const legacy = path.join(torusHome(), "memory", ".reflect-state");
	try {
		unlinkSync(legacy);
		return true;
	} catch {
		return false;
	}
}
