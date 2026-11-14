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
import { knobBoolean, knobNumber, parseZeroDisables } from "./config/knobs.js";
import { projectStateDir } from "./fsutil.js";
import { markerType, parseMarkerType, TORUS_MARKER, type WakeMarkerType } from "./markers.js";
import { osNotify, wakeToast } from "./osnotify.js";
import { isEngineChild } from "./platform.js";
import { currentSessionId, emitTorusCustom } from "./registry.js";
import { sharedState, WAKE_GATE_KEY } from "./shared-state.js";

/** Optional segments for torusWake(); every absent segment leaves no empty parens or dashes. */
export interface TorusWakeOpts {
	/** Process exit code (renders `exit N`) or a preformatted note (e.g. `signal TERM`). */
	code?: number | string | null;
	durationMs?: number | null;
	tail?: string | null;
	hint?: string | null;
}

/** Same whole-second shape as the theme-kit duration formatter, kept local to stay dependency-lean. */
function formatWakeDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/**
 * The one wake-text grammar every producer shares:
 * `[torus] <surface> "<name>" <event> (<code>) in <dur>: <tail> — <hint>`.
 * Event casing is lowercase throughout (`finished`/`failed`); code, duration,
 * tail, and hint are optional and drop out cleanly when absent.
 */
export function torusWake(
	surface: string,
	name: string,
	event: string,
	opts: TorusWakeOpts = {},
): string {
	let text = `[torus] ${surface} "${name}" ${event}`;
	if (typeof opts.code === "number") text += ` (exit ${opts.code})`;
	else if (opts.code) text += ` (${opts.code})`;
	if (typeof opts.durationMs === "number") text += ` in ${formatWakeDuration(opts.durationMs)}`;
	if (opts.tail) text += `: ${opts.tail}`;
	if (opts.hint) text += ` — ${opts.hint}`;
	return text;
}

/** The wake discriminator, typed once and shared by producers and the renderer. */
export type WakeCustomType = WakeMarkerType;

/** Coarse outcome class a producer stamps on its wake; drives the toast policy. */
export type WakeSeverity = "success" | "info" | "warning" | "error";

/**
 * What a producer hands to deliverWake: the typed wake, a human-readable
 * origin, the wake text built via torusWake, and the payload the marker
 * renderer (and the toast policy) read. `toast: false` opts the event out of
 * the desktop toast — delegation results (registry owns that lifecycle toast)
 * and team wakes (marker-only) carry it.
 */
export interface WakeEvent {
	customType: WakeCustomType;
	origin: { label: string };
	severity?: WakeSeverity;
	toast?: boolean;
	summary: string;
	detail?: Record<string, unknown>;
}

/**
 * One pending wake marker, held while the agent is mid-run. `customType`,
 * `details`, and `text` carry exactly what an ungated emit would have sent;
 * `severity`/`toast` ride along so a batch entry keeps its event's delivery flags.
 */
export interface WakeEntry {
	customType: WakeCustomType;
	text: string;
	details?: Record<string, unknown>;
	severity?: WakeSeverity;
	toast?: boolean;
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
 * queued while a run is active, flushed as ONE marker when the run settles.
 * Idle queues debounce for TORUS_WAKE_COALESCE_MS (default 10s, 0 = instant)
 * so several producers landing within the window still cost one turn. A
 * single-entry flush keeps the original
 * customType so renderers and the model see the marker they always saw; only
 * multi-entry flushes wrap in the wake-batch marker.
 *
 * Every queued entry is also write-ahead-logged to a per-session spool file
 * (removed on delivery): a marker that fires while no sender can receive it —
 * runtime replacement, or process exit between queue and flush — is drained
 * into the transcript at the next session_start instead of vanishing.
 */
const gateState = sharedState(
	WAKE_GATE_KEY,
	(): WakeGateState => ({
		pending: [],
		agentActive: false,
	}),
);

export function wakeGateAgentStart(): void {
	gateState.agentActive = true;
	cancelWakeCoalesce();
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
	return knobBoolean("TORUS_WAKE", "wake", "spool", true, parseZeroDisables);
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
			// Spool files written before the typed union carry the `torus.`-prefixed
			// marker spelling; normalize so old records drain into the same gate.
			const customType =
				typeof parsed.entry?.customType === "string"
					? (parseMarkerType(parsed.entry.customType) as WakeCustomType | undefined)
					: undefined;
			if (
				typeof parsed.id === "string" &&
				customType !== undefined &&
				typeof parsed.entry.text === "string"
			) {
				// The spool id lives inside the entry for gate-managed records; a
				// hand-written old record without one still associates through record.id.
				out.push({
					...parsed,
					entry: {
						...parsed.entry,
						customType,
						spoolId: parsed.entry.spoolId ?? parsed.id,
					},
				});
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
	if (!gateState.agentActive) flushIdlePending();
}

/** Idle-side debounce window: entries queued while idle batch for this long (0 = instant). */
const WAKE_COALESCE_MS_DEFAULT = 10_000;
let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

function wakeCoalesceMs(): number {
	const ms = knobNumber("TORUS_WAKE_COALESCE_MS", "wake", "coalesceMs", WAKE_COALESCE_MS_DEFAULT);
	// 0 disables the window (instant flush); junk or negative env keeps the default.
	return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : WAKE_COALESCE_MS_DEFAULT;
}

/**
 * First idle entry arms one unref'd timer; entries queued while it runs join
 * the batch, expiry flushes everything pending. Mid-run the settle-flush owns
 * the backlog, so an active start cancels the timer instead.
 */
function flushIdlePending(): void {
	if (gateState.agentActive || coalesceTimer !== undefined) return;
	const ms = wakeCoalesceMs();
	if (ms <= 0) {
		flushWakeGate();
		return;
	}
	coalesceTimer = setTimeout(() => {
		coalesceTimer = undefined;
		if (!gateState.agentActive) flushWakeGate();
	}, ms);
	coalesceTimer.unref();
}

function cancelWakeCoalesce(): void {
	if (coalesceTimer !== undefined) {
		clearTimeout(coalesceTimer);
		coalesceTimer = undefined;
	}
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
					customType: markerType(single.customType),
					content: [{ type: "text", text: single.text }],
					display: true,
					details: single.details,
				}
			: {
					customType: TORUS_MARKER.wakeBatch,
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
							severity: entry.severity,
							toast: entry.toast,
							// Per-entry text: the joined batch text is unchanged; this lets
							// the renderer read each line on its own.
							text: entry.text,
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

/**
 * The ONE producer entry point: a typed event becomes a gate entry and, when
 * the event opts in (`toast` is not false and a severity is present), a
 * desktop toast per the osnotify policy. Producers never call osNotify or
 * build toasts directly — registry's delegation-lifecycle toasts stay its own.
 */
export function deliverWake(event: WakeEvent): void {
	queueWakeEntry({
		customType: event.customType,
		text: event.summary,
		details: event.detail,
		severity: event.severity,
		toast: event.toast,
	});
	if (event.toast === false || event.severity === undefined) return;
	const toast = wakeToast(event);
	if (toast) osNotify(toast).catch(() => {});
}

/** Test-only: drain the gate immediately, dropping any armed debounce window. */
export function wakeGateFlushForTesting(): void {
	cancelWakeCoalesce();
	flushWakeGate();
}

export function _setWakeGateActiveForTesting(active: boolean): void {
	gateState.agentActive = active;
}

export function _resetWakeGateForTesting(): void {
	cancelWakeCoalesce();
	gateState.pending = [];
	gateState.agentActive = false;
}
