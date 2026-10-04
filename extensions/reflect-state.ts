/**
 * torus — per-session reflect state.
 *
 * Each session owns one JSON file under `TORUS_HOME/reflect-state/` recording
 * when reflection last settled for it. Reads are best-effort (missing or
 * corrupt file → zeros), writes are atomic, and nothing here touches the
 * memory extension (it links against this module, not the reverse).
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { readJson, torusHome, writeJson } from "./fsutil.js";

export interface ReflectState {
	lastReflectSettles: number;
	lastReflectAt: number;
}

const ZERO_STATE: ReflectState = { lastReflectSettles: 0, lastReflectAt: 0 };

export function reflectStateDir(): string {
	return path.join(torusHome(), "reflect-state");
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

export function gcReflectState(maxAgeMs: number, now: number = Date.now()): number {
	try {
		let removed = 0;
		for (const entry of readdirSync(reflectStateDir())) {
			if (!entry.endsWith(".json")) continue;
			const file = path.join(reflectStateDir(), entry);
			if (statSync(file).mtimeMs < now - maxAgeMs) {
				unlinkSync(file);
				removed += 1;
			}
		}
		return removed;
	} catch {
		return 0;
	}
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
