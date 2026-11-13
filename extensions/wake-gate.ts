import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { knobBoolean, parseZeroDisables } from "./config/knobs.js";
import { projectStateDir } from "./fsutil.js";
import { isEngineChild } from "./platform.js";
import { currentSessionId, emitTorusCustom, sharedState } from "./registry.js";

/**
 * One pending wake marker, held while the agent is mid-run. `customType`,
 * `details`, and `text` carry exactly what an ungated emit would have sent.
 */
export interface WakeEntry {
	customType: string;
	text: string;
	details?: Record<string, unknown>;
	/** Spool identity when this entry was write-ahead-logged; delivery clears it from the spool. */
	spoolId?: string;
}

interface WakeGateState {
	pending: WakeEntry[];
	agentActive: boolean;
}

/**
 * Wake gate: the delivery-side batch for session-waking markers (team-wake
 * batches, monitor fires). pi's followUpMode default ("one-at-a-time") drains
 * each queued follow-up as its own model run, so N markers handed to pi while
 * the session is busy trickle out as N wasted turns once it settles — and pi
 * offers no way to un-queue them, which let a deleted team keep waking the
 * session for a minute straight. The gate holds entries in torus instead:
 * queued while a run is active, flushed as ONE marker when the run settles
 * (and immediately when idle). A single-entry flush keeps the original
 * customType so renderers and the model see the marker they always saw; only
 * multi-entry flushes wrap in "torus.wake-batch".
 *
 * Every queued entry is also write-ahead-logged to a per-session spool file
 * (removed on delivery): a marker that fires while no sender can receive it —
 * runtime replacement, or process exit between queue and flush — is drained
 * into the transcript at the next session_start instead of vanishing.
 */
const gateState = sharedState(
	Symbol.for("torus.wake-gate.v1"),
	(): WakeGateState => ({
		pending: [],
		agentActive: false,
	}),
);

export function wakeGateAgentStart(): void {
	gateState.agentActive = true;
}

/** Settle flushes the whole backlog at once; a run aborted mid-flight settles too. */
export function wakeGateAgentSettled(): void {
	gateState.agentActive = false;
	flushWakeGate();
}

/** Undelivered spool records older than this are dropped at drain time. */
const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface SpoolRecord {
	id: string;
	ts: string;
	entry: WakeEntry;
}

function spoolEnabled(): boolean {
	// Engine children have no session to wake; their queue calls are no-ops
	// that must not grow spool files in the dispatching project's state dir.
	if (isEngineChild()) return false;
	return knobBoolean("TORUS_WAKE_SPOOL", "wake", "spool", true, parseZeroDisables);
}

function spoolDir(): string {
	return path.join(projectStateDir(), "wake-spool");
}

function spoolFile(sessionId: string): string {
	return path.join(spoolDir(), `${sessionId}.jsonl`);
}

function appendSpool(sessionId: string, record: SpoolRecord): void {
	try {
		mkdirSync(spoolDir(), { recursive: true });
		appendFileSync(spoolFile(sessionId), `${JSON.stringify(record)}\n`);
	} catch {
		// Best-effort write-ahead: the in-process gate still delivers.
	}
}

function readSpool(sessionId: string): SpoolRecord[] {
	let raw: string;
	try {
		raw = readFileSync(spoolFile(sessionId), "utf8");
	} catch {
		return [];
	}
	const out: SpoolRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") continue;
		try {
			const parsed = JSON.parse(line) as SpoolRecord;
			if (
				typeof parsed.id === "string" &&
				typeof parsed.entry?.customType === "string" &&
				typeof parsed.entry.text === "string"
			) {
				out.push(parsed);
			}
		} catch {}
	}
	return out;
}

function writeSpool(sessionId: string, records: SpoolRecord[]): void {
	try {
		if (records.length === 0) rmSync(spoolFile(sessionId), { force: true });
		else {
			writeFileSync(spoolFile(sessionId), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
		}
	} catch {}
}

function removeFromSpool(sessionId: string, ids: Set<string>): void {
	if (ids.size === 0) return;
	writeSpool(
		sessionId,
		readSpool(sessionId).filter((r) => !ids.has(r.id)),
	);
}

function gcSpool(): void {
	const now = Date.now();
	let files: string[];
	try {
		files = readdirSync(spoolDir());
	} catch {
		return;
	}
	for (const file of files) {
		const full = path.join(spoolDir(), file);
		try {
			if (now - statSync(full).mtimeMs > SPOOL_MAX_AGE_MS) rmSync(full);
		} catch {}
	}
}

export function queueWakeEntry(entry: WakeEntry): void {
	const sessionId = currentSessionId();
	let queued = entry;
	if (sessionId !== null && spoolEnabled()) {
		const spoolId = randomUUID();
		queued = { ...entry, spoolId };
		appendSpool(sessionId, { id: spoolId, ts: new Date().toISOString(), entry: queued });
	}
	gateState.pending.push(queued);
	if (!gateState.agentActive) flushWakeGate();
}

/** Removes matching held entries (e.g. a deleted team's undelivered wake); returns the drop count. */
export function dropWakeEntries(match: (entry: WakeEntry) => boolean): number {
	const kept: WakeEntry[] = [];
	const dropped: WakeEntry[] = [];
	for (const entry of gateState.pending) (match(entry) ? dropped : kept).push(entry);
	gateState.pending = kept;
	const sessionId = currentSessionId();
	if (sessionId !== null) {
		removeFromSpool(sessionId, new Set(dropped.flatMap((e) => (e.spoolId ? [e.spoolId] : []))));
	}
	return dropped.length;
}

export function flushWakeGate(): void {
	const entries = gateState.pending.splice(0);
	if (entries.length === 0) return;
	const single = entries.length === 1 ? entries[0] : undefined;
	const emitted = emitTorusCustom(
		single
			? {
					customType: single.customType,
					content: [{ type: "text", text: single.text }],
					display: true,
					details: single.details,
				}
			: {
					customType: "torus.wake-batch",
					content: [
						{
							type: "text",
							text: entries.map((entry) => entry.text).join("\n"),
						},
					],
					display: true,
					details: {
						count: entries.length,
						entries: entries.map((entry) => ({
							customType: entry.customType,
							details: entry.details,
						})),
					},
				},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	if (emitted) {
		const sessionId = currentSessionId();
		if (sessionId !== null) {
			removeFromSpool(sessionId, new Set(entries.flatMap((e) => (e.spoolId ? [e.spoolId] : []))));
		}
	}
	// No sender (child sessions, tests): the backlog is spent either way — a
	// marker that never reached a session must not resurrect on a later settle;
	// its spool copy survives for the next session_start drain.
}

/**
 * Deliver wakes that fired while no live session could receive them: runtime
 * replacement dropped the sender mid-flight, or the process exited between
 * queue and flush. Loaded entries join the gate (deduped against anything
 * already pending) and flush when the session is idle — each keeps its
 * original customType and triggers a turn exactly as if it had arrived live.
 * Spool files from sessions that never came back age out on the same pass.
 */
export function drainWakeSpool(sessionId: string): void {
	if (!spoolEnabled()) return;
	gcSpool();
	const records = readSpool(sessionId);
	if (records.length === 0) return;
	const inGate = new Set(gateState.pending.flatMap((e) => (e.spoolId ? [e.spoolId] : [])));
	for (const record of records) {
		if (!inGate.has(record.id)) gateState.pending.push(record.entry);
	}
	if (!gateState.agentActive) flushWakeGate();
}

export function _setWakeGateActiveForTesting(active: boolean): void {
	gateState.agentActive = active;
}

export function _resetWakeGateForTesting(): void {
	gateState.pending = [];
	gateState.agentActive = false;
}
