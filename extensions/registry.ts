/**
 * torus — delegation registry.
 *
 * Every running delegation is tracked here, tees its turn snapshots to a log
 * file (which tmux panes tail), and is listed by the /torus browser overlay.
 */

import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { runChild } from "./child-run.js";
import { flattenPreview } from "./fleet/theme-kit.js";
import {
	formatCost,
	projectKeyFor,
	projectStateDir,
	readHead,
	torusHome,
	writeJson,
} from "./fsutil.js";
import { type DelegationToastInfo, notifyDelegation, RUNNING_LATE_MS } from "./osnotify.js";

export interface DelegationRecord {
	id: string;
	agent: string;
	model: string;
	handle: string | null;
	status: "running" | "done" | "failed";
	startedAt: number;
	/** Wall-clock completion time, set once the run leaves "running". */
	finishedAt?: number;
	turns: number;
	tokensIn: number;
	tokensOut: number;
	/** Prompt-cache tokens read/written across the run (engine usage). */
	cacheRead: number;
	cacheWrite: number;
	/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
	cost: number;
	text: string;
	/** True when text is a head slice of a longer final text; the complete text lives in the delegation log. */
	textTruncated?: boolean;
	logFile: string;
	sessionId: string | null;
	parentSession: string | null;
	/** Project key (state-dir identity) of the cwd the delegation runs in — informational; the log itself lives in the dispatching session's state dir. */
	project: string;
	paneId: string | null;
	/**
	 * Pid of the run's child process (engine RPC/JSON child, ACP client) when
	 * known — the liveness key for orphan reconciliation and rehydration: an
	 * undriven running record whose child is dead is terminalized from its
	 * transcript, one whose child still lives stays running truthfully.
	 */
	childPid?: number;
	/** Set when the operator stops the run from the fleet view; the run settles failed but its outcome reports interrupted. */
	stopRequested?: boolean;
}

export function normalizeHandle(raw: string | null | undefined): string | null {
	const cleaned =
		raw
			?.trim()
			.replace(/^@+/, "")
			.replace(/\s+/g, "-")
			.replace(/[^a-zA-Z0-9-]/g, "")
			.slice(0, 24) ?? "";
	return cleaned.length > 0 ? cleaned : null;
}

/** Single-quote a value for safe interpolation into a shell command string. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Pending "still running" toasts, keyed by delegation id; cleared on finish. */
interface LateToast {
	timer: ReturnType<typeof setTimeout> | null;
	/** Server notification id of the fired interim toast, replaced by the finish toast; a pending id arrives async and is awaited by the finish toast. */
	notificationId: number | Promise<number | null> | null;
}
const lateToasts = new Map<string, LateToast>();

function toastInfo(record: DelegationRecord): DelegationToastInfo {
	return {
		agent: record.agent,
		handle: record.handle,
		model: record.model,
		startedAt: record.startedAt,
		turns: record.turns,
		tokensIn: record.tokensIn,
		tokensOut: record.tokensOut,
		text: record.text,
	};
}

/** Agent names reach shell command lines and tmux format strings — allowlist strictly. */
export const AGENT_NAME_RE = /^[a-z0-9-]+$/;

/** Replace credential-shaped substrings with [redacted] before tool args are logged. */
export function redactSecrets(text: string): string {
	return text
		.replace(/(Authorization\s*:\s*(?:Bearer\s+)?)[^\s"']+/gi, "$1[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
		.replace(
			/([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*)\s*=\s*[^\s"']+/gi,
			"$1=[redacted]",
		);
}

/**
 * Absolute path of the dispatching project's delegation-log directory
 * (state/--<project>--/logs). Delegation logs always land here — a child
 * running in another cwd (e.g. a worktree) logs into the dispatching
 * session's root, never its own, so worktree-keyed state dirs stop appearing.
 */
export function logsDir(): string {
	return path.join(projectStateDir(), "logs");
}

/**
 * Newest-first (lexicographic) delegation log file paths from the project
 * state logs dir, at most `n`.
 */
export function recentLogFiles(n: number): string[] {
	const found: string[] = [];
	try {
		for (const file of readdirSync(logsDir())) {
			if (file.endsWith(".log")) found.push(file);
		}
	} catch {}
	return found
		.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		.slice(0, n)
		.map((file) => path.join(logsDir(), file));
}

/**
 * pi loads each manifest extension entry with its own module root, so a plain
 * module-level Map would be a DIFFERENT instance per entry (observed: the
 * browser entry saw an empty registry while the roster entry populated
 * another). State that must cross entries lives on globalThis instead.
 */
export function sharedState<T>(key: symbol, init: () => T): T {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[key] as T | undefined;
	if (existing !== undefined) return existing;
	const created = init();
	store[key] = created;
	return created;
}

const REGISTRY_KEY = Symbol.for("torus.delegation-registry");
const registry = sharedState(REGISTRY_KEY, () => new Map<string, DelegationRecord>());

const OBSERVERS_KEY = Symbol.for("torus.delegation-observers");
const usageObservers = sharedState(
	OBSERVERS_KEY,
	() => new Set<(record: DelegationRecord) => void>(),
);

/**
 * Subscribe to usage-bearing delegation record changes: every per-turn
 * updateDelegation, every finishDelegation, and every rehydrated record. The
 * observer receives the record after mutation, so record.cost is the run's
 * running total (final on finish/rehydrate). Returns an unsubscribe.
 */
export function onDelegationUsageChange(observer: (record: DelegationRecord) => void): () => void {
	usageObservers.add(observer);
	return () => {
		usageObservers.delete(observer);
	};
}

/** Observer throws must never break a delegation's bookkeeping. */
function notifyUsageChange(record: DelegationRecord): void {
	for (const observer of usageObservers) {
		try {
			observer(record);
		} catch {}
	}
}

const CONTROLS_KEY = Symbol.for("torus.delegation-controls");
const controls = sharedState(CONTROLS_KEY, () => new Map<string, DelegationControl>());

const PERSONA_KEY = Symbol.for("torus.session-persona");

export function sessionPersona(): string | null {
	return sharedState<string | null>(PERSONA_KEY, () => null);
}

export function setSessionPersona(name: string | null): void {
	(globalThis as Record<symbol, unknown>)[PERSONA_KEY] = name;
}

/** Shared slot for the current session id, written on session_start. */
export const CURRENT_SESSION = Symbol.for("torus.current-session");

/** Shared slot for the fleet-overlay opener the notify layer clicks into. */
export const FLEET_OPENER = Symbol.for("torus.fleet-opener");

const CUSTOM_SENDER_KEY = Symbol.for("torus.custom-sender");

export interface TorusCustomMessage {
	customType: string;
	content: Array<{ type: "text"; text: string }>;
	display?: boolean;
	details?: Record<string, unknown>;
}

export interface TorusCustomOptions {
	deliverAs?: "steer" | "followUp" | "nextTurn";
	triggerTurn?: boolean;
}

type TorusCustomSender = (message: TorusCustomMessage, options?: TorusCustomOptions) => void;

/**
 * Custom-message sender slot, globalThis-hosted because pi loads each manifest
 * entry as its own module root: roster registers the sender, but memory's
 * roster import is a separate module instance and must reach the same slot
 * for dream notifications to reach the transcript.
 */
const senderState = sharedState<{ sender?: TorusCustomSender }>(CUSTOM_SENDER_KEY, () => ({}));

export function setCustomSender(sender: TorusCustomSender): void {
	senderState.sender = sender;
}

/**
 * Emit a torus custom message into the live session (transcript marker +
 * model context). Returns false when no session sender is registered (tests
 * without one, or engine-child sessions) or when the registered sender's ctx
 * went stale: the sender closure captures the registration-time extension
 * ctx, and a session replacement (fork/resume/new, or print-mode teardown)
 * invalidates it while background runs (dream, reflection, wake-gate
 * flushes) are still in flight — the engine throws its stale-ctx error from
 * the dead ctx at exactly that moment. Markers are best-effort, and the
 * replacement session's own registration re-arms the sender, so the marker
 * drops instead of killing the run that emitted it. Any other failure is a
 * real bug and keeps throwing.
 */
export function emitTorusCustom(
	message: TorusCustomMessage,
	options?: TorusCustomOptions,
): boolean {
	if (!senderState.sender) return false;
	try {
		senderState.sender(message, options);
		return true;
	} catch (error) {
		if (error instanceof Error && error.message.includes("stale after session replacement")) {
			return false;
		}
		throw error;
	}
}

export function currentSessionId(): string | null {
	return ((globalThis as Record<symbol, unknown>)[CURRENT_SESSION] as string | null) ?? null;
}

export function setCurrentSessionId(id: string | null): void {
	(globalThis as Record<symbol, unknown>)[CURRENT_SESSION] = id;
}

export interface DelegationControl {
	stop: () => void;
	/** @returns true when the steer reached a live child; false when it is a no-op stub. */
	steer: (text: string) => boolean;
	/** Child process pid when the control's creator holds the process; recorded on the delegation record and log. */
	pid?: number;
}

export function attachControl(id: string, control: DelegationControl): void {
	controls.set(id, control);
	if (typeof control.pid === "number") attachChildPid(id, control.pid);
}

/**
 * Record the run's child pid: set on the record, appended to the log as a
 * <torus:pid> tag (rehydrateFromLogs parses it back), and carried on run
 * beacons. A chain walk's model fallbacks respawn children, so a later attach
 * with a different pid replaces the record's value and appends a second tag —
 * rehydrate keeps the last one.
 */
export function attachChildPid(id: string, pid: number): void {
	const record = registry.get(id);
	if (!record || record.childPid === pid) return;
	record.childPid = pid;
	appendFileSync(record.logFile, `\n<torus:pid pid="${pid}" ts="${new Date().toISOString()}" />\n`);
}

export function stopDelegation(id: string): boolean {
	const record = registry.get(id);
	if (record?.status !== "running") return false;
	record.stopRequested = true;
	appendFileSync(record.logFile, `\n<torus:stop-requested ts="${new Date().toISOString()}" />\n`);
	controls.get(id)?.stop();
	return true;
}

/** True once the operator stopped this run from the fleet view; the settling outcome reports interrupted instead of failed. */
export function delegationStopRequested(id: string): boolean {
	return registry.get(id)?.stopRequested === true;
}

/** Steer log entry for a delegation action log; credential shapes redacted before flattening. */
export function steerLogLine(
	text: string,
	delivered: boolean,
	ts = new Date().toISOString(),
): string {
	// Redaction first: flattenPreview collapses whitespace but never redacts.
	const safe = flattenPreview(redactSecrets(text), 200);
	return `\n[${ts}] steer${delivered ? "" : " (no-op)"}: ${safe}\n`;
}

export function steerDelegation(id: string, text: string): boolean {
	const record = registry.get(id);
	if (record?.status !== "running") return false;
	const control = controls.get(id);
	if (!control) return false;
	const delivered = control.steer(text);
	appendFileSync(record.logFile, steerLogLine(text, delivered));
	return delivered;
}

const EXTERNAL_RUNS_KEY = Symbol.for("torus.external-runs.v1");
const EXTERNAL_RUNS_LIMIT = 100;

export type ExternalRunState = "running" | "done" | "failed";

export interface ExternalRun {
	id: string;
	source: string;
	label: string;
	handle?: string;
	model?: string;
	logFile?: string;
	sessionId?: string;
	memberStatus?: "working" | "idle" | "stopped";
	/** Seconds of active (non-idle) work; the displayed age freezes while idle. */
	activeSeconds?: number;
	/** When activeSeconds was last computed (now-active members tick from this). */
	activeUpdatedAt?: number;
	state: ExternalRunState;
	startedAt: number;
	turns?: number;
	tokensIn?: number;
	tokensOut?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
	cost?: number;
}

export function externalRunAgeSeconds(run: ExternalRun): number {
	if (run.activeSeconds === undefined)
		return Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
	const elapsed =
		run.memberStatus === "idle"
			? 0
			: Math.max(0, Date.now() - (run.activeUpdatedAt ?? run.startedAt));
	return run.activeSeconds + Math.floor(elapsed / 1000);
}

function externalRuns(): ExternalRun[] {
	return sharedState(EXTERNAL_RUNS_KEY, () => [] as ExternalRun[]);
}

/** The team publish's ExternalRun fields mapped into their RunRecord slots; the write merges over the record startDelegation planted. */
function externalRunBeacon(run: ExternalRun): RunRecordWrite {
	return {
		id: run.id,
		status: run.state,
		pid: process.pid,
		source: run.source,
		label: run.label,
		...(run.handle !== undefined ? { handle: run.handle } : {}),
		...(run.model !== undefined ? { model: run.model } : {}),
		...(run.logFile !== undefined ? { logFile: run.logFile } : {}),
		...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
		...(run.memberStatus !== undefined ? { memberStatus: run.memberStatus } : {}),
		...(run.activeSeconds !== undefined ? { activeSeconds: run.activeSeconds } : {}),
		...(run.activeUpdatedAt !== undefined ? { activeUpdatedAt: run.activeUpdatedAt } : {}),
		...(run.turns !== undefined ? { turns: run.turns } : {}),
		...(run.tokensIn !== undefined ? { tokensIn: run.tokensIn } : {}),
		...(run.tokensOut !== undefined ? { tokensOut: run.tokensOut } : {}),
		...(run.cacheRead !== undefined ? { cacheRead: run.cacheRead } : {}),
		...(run.cacheWrite !== undefined ? { cacheWrite: run.cacheWrite } : {}),
		...(run.cost !== undefined ? { cost: run.cost } : {}),
	};
}

export function publishExternalRun(
	run: Omit<ExternalRun, "startedAt"> & { startedAt?: number },
): void {
	const runs = externalRuns();
	const existing = runs.findIndex((r) => r.id === run.id);
	if (existing >= 0) {
		const prior = runs[existing];
		if (prior) runs[existing] = { ...prior, ...run, startedAt: prior.startedAt };
		return;
	}
	const started = { startedAt: Date.now(), ...run };
	runs.push(started);
	while (runs.length > EXTERNAL_RUNS_LIMIT) runs.shift();
	writeRunBeacon(externalRunBeacon(started));
}

export function updateExternalRun(
	id: string,
	patch: Partial<
		Pick<
			ExternalRun,
			| "state"
			| "label"
			| "handle"
			| "turns"
			| "tokensIn"
			| "tokensOut"
			| "cacheRead"
			| "cacheWrite"
			| "cost"
			| "sessionId"
			| "memberStatus"
			| "activeSeconds"
			| "activeUpdatedAt"
		>
	>,
): void {
	const run = externalRuns().find((r) => r.id === id);
	if (run) Object.assign(run, patch);
}

const RUNS_DIR = path.join(torusHome(), "runs");
/** Finished run records are kept this long past their finish; running records are count-capped, not aged. */
const RUNS_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const RUNS_PRUNE_COUNT = 200;
/** A "running" beacon with a dead writer pid is a zombie this long after its last write. */
const RUNS_ZOMBIE_MS = 10 * 60 * 1000;

/**
 * The on-disk run record: one JSON file per run in RUNS_DIR, written by both
 * origins (delegations from DelegationRecord, team members through
 * publishExternalRun). Every field beyond the identity core is optional so
 * identity-only files written by older binaries load cleanly; the scan zeroes
 * missing stats instead of rejecting the file.
 */
export interface RunRecord {
	id: string;
	agent: string;
	model: string;
	status: "running" | "done" | "failed";
	startedAt: number;
	pid: number;
	/** Child process pid when known; the writer pid above stays the ownership key. */
	childPid?: number;
	uid?: number;
	parentSession: string | null;
	sessionId: string | null;
	/** Project key of the delegation's cwd — the fleet is cross-project by design. */
	project: string;
	/** Action-log path so foreign runs can render output before the first turn. */
	logFile?: string;
	// Full-record fold-in. All optional: identity-only files load cleanly and
	// each origin writes only the slots it knows (the write merges over the
	// on-disk record, so origins never erase each other's fields).
	handle?: string | null;
	label?: string;
	/** Origin tag (`torus-team:<id>` for members); plain delegations carry none on disk. */
	source?: string;
	finishedAt?: number;
	turns?: number;
	tokensIn?: number;
	tokensOut?: number;
	/** Prompt-cache tokens read/written across the run (engine usage). */
	cacheRead?: number;
	cacheWrite?: number;
	/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
	cost?: number;
	/** Bounded head of the final text; the complete text lives in the run's log. */
	text?: string;
	textTruncated?: boolean;
	stopRequested?: boolean;
	paneId?: string | null;
	memberStatus?: "working" | "idle" | "stopped";
	/** Seconds of active (non-idle) work; the displayed age freezes while idle. */
	activeSeconds?: number;
	/** When activeSeconds was last computed (now-active members tick from this). */
	activeUpdatedAt?: number;
}

/** Fields every write must carry; the rest merge from the on-disk record. */
type RunRecordWrite = Pick<RunRecord, "id" | "status"> & Partial<RunRecord>;

/**
 * The full current record as a beacon write: every DelegationRecord field
 * lands in its RunRecord slot. text keeps the same bounded head the registry
 * holds, so the record on disk stays complete without pinning unbounded
 * final text in a file.
 */
function recordBeacon(record: DelegationRecord): RunRecord {
	return {
		id: record.id,
		agent: record.agent,
		model: record.model,
		status: record.status,
		startedAt: record.startedAt,
		pid: process.pid,
		...(record.childPid !== undefined ? { childPid: record.childPid } : {}),
		parentSession: record.parentSession,
		sessionId: record.sessionId,
		project: record.project,
		logFile: record.logFile,
		handle: record.handle,
		paneId: record.paneId,
		...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
		turns: record.turns,
		tokensIn: record.tokensIn,
		tokensOut: record.tokensOut,
		cacheRead: record.cacheRead,
		cacheWrite: record.cacheWrite,
		cost: record.cost,
		text: record.text.slice(0, RECORD_TEXT_CAP),
		...(record.textTruncated || record.text.length > RECORD_TEXT_CAP
			? { textTruncated: true }
			: {}),
		...(record.stopRequested ? { stopRequested: true } : {}),
	};
}

function beaconFile(id: string): string {
	return path.join(RUNS_DIR, `${id}.json`);
}

function writeRunBeacon(record: RunRecordWrite): void {
	try {
		const file = beaconFile(record.id);
		// Team-member ids are "teamId/member" — a subdirectory RUNS_DIR does not
		// have yet. Without the mkdir every member beacon write fails silently
		// and member liveness never survives a process reload.
		mkdirSync(path.dirname(file), { recursive: true });
		// Merge over the on-disk record: two origins write the same member file
		// (the delegation path's full record and the team publish's source/
		// label), and each write carries only the fields its origin knows.
		let prior: Partial<RunRecord> = {};
		try {
			prior = JSON.parse(readFileSync(file, "utf8")) as Partial<RunRecord>;
		} catch {}
		const merged: Partial<RunRecord> & { uid?: number } = {
			...prior,
			...record,
			uid: process.getuid?.(),
		};
		// Explicit undefined slots must not erase a field the other origin wrote.
		for (const key of Object.keys(merged) as (keyof RunRecord)[]) {
			if (merged[key] === undefined) delete merged[key];
		}
		writeJson(file, merged);
	} catch {}
}

/**
 * Beacon-write throttle state: last status and time written per record. A
 * running delegation updates every turn, but a same-status beacon carries no
 * new fleet information — rewriting it each turn is 3 fs ops for nothing.
 */
const BEACON_MIN_INTERVAL_MS = 10_000;
const lastBeaconWrites = new Map<string, { status: RunRecord["status"]; at: number }>();

function writeRunBeaconThrottled(record: RunRecordWrite): void {
	const now = Date.now();
	const last = lastBeaconWrites.get(record.id);
	if (last && last.status === record.status && now - last.at < BEACON_MIN_INTERVAL_MS) return;
	writeRunBeacon(record);
	lastBeaconWrites.set(record.id, { status: record.status, at: now });
}

/**
 * Prune the run-record store. Finished records prune by run age (finishedAt
 * else startedAt, RUNS_PRUNE_MS); running records are not aged but capped at
 * RUNS_PRUNE_COUNT (oldest file mtime goes first), and a "running" record
 * whose writer pid is long dead is a zombie: the driving process died before
 * finalizing (killed sessions, aborted-before-spawn runs), and the row
 * renders in every fleet view for the rest of the prune window — hours-old
 * running ghosts. Age the zombie check so a freshly spawned run is never
 * raced. Corrupt files keep their old mtime-based cleanup. Like the scan,
 * this pass carries no uid filter, so it deletes other processes' finished
 * and zombie files exactly as before — deletion scope is unchanged.
 */
export function pruneRunBeacons(now: number): void {
	try {
		const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
		const stale: string[] = [];
		const running: { file: string; mtime: number }[] = [];
		for (const file of files) {
			const full = path.join(RUNS_DIR, file);
			let mtime: number;
			try {
				mtime = statSync(full).mtimeMs;
			} catch {
				continue; // vanished mid-scan
			}
			let record: RunRecord | undefined;
			try {
				record = JSON.parse(readFileSync(full, "utf8")) as RunRecord;
			} catch {}
			if (record?.status === "running") {
				if (record.pid !== process.pid && !pidAlive(record.pid) && now - mtime > RUNS_ZOMBIE_MS) {
					try {
						rmSync(full);
					} catch {}
					continue;
				}
				running.push({ file, mtime });
				continue;
			}
			const ageAt =
				typeof record?.finishedAt === "number"
					? record.finishedAt
					: typeof record?.startedAt === "number"
						? record.startedAt
						: mtime;
			if (now - ageAt > RUNS_PRUNE_MS) stale.push(file);
		}
		const excess = Math.max(0, running.length - RUNS_PRUNE_COUNT);
		const oldest = running
			.sort((a, b) => a.mtime - b.mtime)
			.slice(0, excess)
			.map((e) => e.file);
		for (const file of [...stale, ...oldest]) {
			try {
				rmSync(path.join(RUNS_DIR, file));
			} catch {}
		}
	} catch {}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const EXTERNAL_RUNS_CACHE_TTL_MS = 1_000;

/**
 * The fleet overlay re-renders every 80ms; without this cache the scan below
 * would readdir + JSON.parse + kill(pid, 0) the runs dir ~12.5x/sec.
 */
/**
 * Parse every own-uid run record in RUNS_DIR: readdir + try-parse, keeping
 * only files whose id matches the filename stem (the traversal gate) and
 * whose uid is ours when tagged. Corrupt JSON is skipped, not fatal.
 * Identity-only files written by older binaries load with zeroed stats.
 */
function readRunBeacons(): RunRecord[] {
	const out: RunRecord[] = [];
	let files: string[];
	try {
		files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	const uid = process.getuid?.();
	for (const file of files) {
		let record: RunRecord;
		try {
			record = JSON.parse(readFileSync(path.join(RUNS_DIR, file), "utf8")) as RunRecord;
		} catch {
			continue;
		}
		if (record.id !== file.slice(0, -".json".length)) continue;
		if (typeof record.uid === "number" && typeof uid === "number" && record.uid !== uid) continue;
		record.turns ??= 0;
		record.tokensIn ??= 0;
		record.tokensOut ??= 0;
		record.cacheRead ??= 0;
		record.cacheWrite ??= 0;
		out.push(record);
	}
	return out;
}

let externalRunsCache: { at: number; runs: RunRecord[] } | null = null;

function foreignRunningBeacons(): RunRecord[] {
	const now = Date.now();
	if (externalRunsCache && now - externalRunsCache.at < EXTERNAL_RUNS_CACHE_TTL_MS)
		return externalRunsCache.runs;
	// Dead-pid beacons are reported in memory only — never rewrite a foreign
	// process's file. Consumers filter on state, so a failed entry drops out
	// of the fleet views exactly as the on-disk rewrite used to make it.
	const out = readRunBeacons()
		.filter((r) => r.pid !== process.pid && r.status === "running")
		.map((r) => (pidAlive(r.pid) ? r : { ...r, status: "failed" as const }));
	externalRunsCache = { at: now, runs: out };
	return out;
}
/**
 * All run beacons (any status, same uid) keyed by action-log path — rehydrate
 * cross-references these so a live member's log is not rebuilt as a duplicate
 * "failed" record next to its authoritative external row.
 */
function beaconsByLogFile(): Map<string, RunRecord> {
	const out = new Map<string, RunRecord>();
	for (const record of readRunBeacons()) {
		if (typeof record.logFile === "string" && record.logFile.length > 0)
			out.set(record.logFile, record);
	}
	return out;
}

/**
 * External runs not already onboarded as delegation records: team members
 * are registered in both (startDelegation + publishExternalRun), and fleet
 * views render both lists — without this filter every member shows up twice.
 */
export function listExternalRunsExcludingDelegations(): ExternalRun[] {
	const delegated = new Set(registry.keys());
	return listExternalRuns().filter((run) => !delegated.has(run.id));
}

export function listExternalRuns(): ExternalRun[] {
	const current = getCurrentSession();
	const local = [...externalRuns()].sort((a, b) => b.startedAt - a.startedAt);
	const foreign = foreignRunningBeacons()
		.filter((beacon) => current === null || beacon.parentSession === current)
		.map((beacon): ExternalRun => {
			// Disk-provided origin fields win; identity-only beacons keep the
			// synthetic torus-run source and agent-as-label.
			return {
				id: beacon.id,
				source: beacon.source ?? `torus-run:${beacon.pid}`,
				label: beacon.label ?? beacon.agent,
				handle: beacon.handle ?? undefined,
				model: beacon.model,
				sessionId: beacon.sessionId ?? undefined,
				logFile: beacon.logFile,
				state:
					beacon.status === "done" ? "done" : beacon.status === "failed" ? "failed" : "running",
				startedAt: beacon.startedAt,
				memberStatus: beacon.memberStatus,
				activeSeconds: beacon.activeSeconds,
				activeUpdatedAt: beacon.activeUpdatedAt,
				turns: beacon.turns,
				tokensIn: beacon.tokensIn,
				tokensOut: beacon.tokensOut,
				cacheRead: beacon.cacheRead,
				cacheWrite: beacon.cacheWrite,
				cost: beacon.cost,
			};
		});
	return [...local, ...foreign].sort((a, b) => b.startedAt - a.startedAt);
}

const CURRENT_SESSION_KEY = Symbol.for("torus.current-session");

/**
 * Foreign run-beacons are session-scoped: without this marker every torus
 * process would surface every other process's delegations in its fleet.
 * Null (headless/tests) preserves the unfiltered scan for compatibility.
 */
export function setCurrentSession(id: string | null): void {
	(globalThis as Record<symbol, unknown>)[CURRENT_SESSION_KEY] = id;
}

export function getCurrentSession(): string | null {
	const id = (globalThis as Record<symbol, unknown>)[CURRENT_SESSION_KEY];
	return typeof id === "string" ? id : null;
}

export type TeamStatus = "active" | "shutdown";

export interface TeamMemberRecord {
	id: string;
	name: string;
	agent: string;
	model: string;
	status: "starting" | "working" | "idle" | "stopped";
	sessionId: string | null;
	startedAt: number;
	mailboxDir: string;
}

export interface TeamRecord {
	id: string;
	name: string;
	objective: string;
	status: TeamStatus;
	dir: string;
	members: TeamMemberRecord[];
	createdAt: number;
}

const TEAMS_KEY = Symbol.for("torus.teams.v1");

function teams(): Map<string, TeamRecord> {
	return sharedState(TEAMS_KEY, () => new Map<string, TeamRecord>());
}

export function registerTeam(record: TeamRecord): void {
	teams().set(record.id, record);
}

export function getTeam(id: string): TeamRecord | undefined {
	return teams().get(id);
}

export function listTeams(): TeamRecord[] {
	return [...teams().values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function dropTeam(id: string): void {
	teams().delete(id);
}

/**
 * Resolves the torus repo root. Under pi's extension loader, import.meta
 * dirname can remap to a different module root, so anchor on TORUS_ROOT
 * (set by the launcher) and fall back to a find-up scan for our package.json.
 */
export function repoRoot(): string {
	const fromEnv = process.env["TORUS_ROOT"];
	if (fromEnv) return fromEnv;
	let dir = import.meta.dirname;
	for (let i = 0; i < 6; i += 1) {
		try {
			if (readFileSync(path.join(dir, "package.json"), "utf8").includes('"torus"')) return dir;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

export function listDelegations(): DelegationRecord[] {
	return [...registry.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Test-only: clear in-memory registry + controls so rehydration can be exercised repeatedly. */
export function resetRegistryForTesting(): void {
	registry.clear();
	controls.clear();
	externalRuns().length = 0;
	lateToasts.clear();
	lastBeaconWrites.clear();
}

/**
 * Async tmux runner: spawn, pipe stdout, buffer, resolve on close — never
 * blocks the engine event loop. A stuck server is killed after 5s.
 */
function runTmux(args: string[]): Promise<{ ok: boolean; stdout: string }> {
	return runChild("tmux", args, { timeoutMs: 5000 }).then((run) => ({
		ok: run.status === 0,
		stdout: run.stdout.trim(),
	}));
}

/**
 * Open a tmux pane tailing the delegation log. Any failure (no server, no
 * client, no split) yields a null paneId and the run continues paneless.
 */
async function tmuxPaneFor(
	logFile: string,
	agent: string,
	handle: string | null,
): Promise<string | null> {
	if (process.env["TORUS_TMUX"] === "0" || !process.env["TMUX"]) return null;
	// No has-session pre-check: a failed split-window already implies no
	// server, and any non-zero exit counts as "no pane".
	const split = await runTmux([
		"split-window",
		"-h",
		"-P",
		"-F",
		"#{pane_id}",
		"-l",
		"35%",
		`tail -n +1 -f ${shellQuote(logFile)}`,
	]);
	if (!split.ok || split.stdout === "") return null;
	const paneId = split.stdout;
	// One invocation for the follow-ups: focus back, border on, title the pane.
	await runTmux([
		"select-pane",
		"-L",
		";",
		"set-option",
		"-p",
		"-t",
		paneId,
		"pane-border-status",
		"top",
		";",
		"select-pane",
		"-t",
		paneId,
		"-T",
		`torus: ${handle ? `@${handle}` : agent}`,
	]);
	return paneId;
}

async function killPane(paneId: string | null): Promise<void> {
	if (!paneId) return;
	await runTmux(["kill-pane", "-t", paneId]);
}

export async function startDelegation(
	id: string,
	agent: string,
	model: string,
	parentSession: string | null = null,
	handle: string | null = null,
	cwd: string = process.cwd(),
): Promise<DelegationRecord> {
	const dir = logsDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// chmod covers a pre-existing directory created with wider perms
	chmodSync(dir, 0o700);
	// The full id makes the name unique by construction: two same-agent
	// delegations spawned in one fanout tick share a millisecond but never an
	// id, so logs never interleave and result text read back from a log is
	// always this run's own final message. The timestamp stays first so
	// rehydrateFromLogs' reverse sort by recency keeps working; the id is
	// stripped to filename-safe characters.
	const logFile = path.join(
		dir,
		`${new Date().toISOString().replace(/[:.]/g, "-")}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}-${agent}.log`,
	);
	// delegation logs capture tool args — enforce owner-only from birth
	appendFileSync(logFile, "");
	chmodSync(logFile, 0o600);
	const normalizedHandle = normalizeHandle(handle);
	const record: DelegationRecord = {
		id,
		agent,
		model,
		handle: normalizedHandle,
		status: "running",
		startedAt: Date.now(),
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
		logFile,
		sessionId: null,
		parentSession,
		project: projectKeyFor(cwd),
		// The pane opens asynchronously below; the record registers first so a
		// stop or steer during the split-window race still lands on this record.
		paneId: null,
	};
	registry.set(id, record);
	const late: LateToast = { timer: null, notificationId: null };
	late.timer = setTimeout(() => {
		const current = registry.get(id);
		if (current?.status === "running") {
			late.notificationId = notifyDelegation("running-late", toastInfo(current));
		}
	}, RUNNING_LATE_MS);
	late.timer.unref();
	lateToasts.set(id, late);
	pruneRunBeacons(Date.now());
	writeRunBeaconThrottled(recordBeacon(record));
	appendFileSync(
		logFile,
		`<torus:start${formatStartAttrs(agent, model, normalizedHandle, parentSession)} />\n`,
	);
	record.paneId = await tmuxPaneFor(logFile, agent, normalizedHandle);
	return record;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function formatStartAttrs(
	agent: string,
	model: string,
	handle: string | null,
	parentSession: string | null,
): string {
	let attrs = ` agent="${escapeAttr(agent)}" model="${escapeAttr(model)}" ts="${new Date().toISOString()}"`;
	if (handle) attrs += ` handle="${escapeAttr(handle)}"`;
	if (parentSession) attrs += ` parent="${escapeAttr(parentSession)}"`;
	return attrs;
}

export function appendAction(id: string, line: string): void {
	const record = registry.get(id);
	if (!record) return;
	appendFileSync(record.logFile, `${line}\n`);
}

export function attachSessionId(id: string, sessionId: string): void {
	const record = registry.get(id);
	if (!record) return;
	// A chain walk's respawned children each report their own session id: the
	// record carries the LATEST leg so the live transcript follows the child
	// that is doing work instead of staying on a dead early attempt. Every
	// leg's tag persists in the log so rehydrateFromLogs recovers the last one
	// for an un-ended log (end tags carry the final id, but an orphaned run
	// never writes one — and spend folding keys on the transcript it names).
	if (record.sessionId === sessionId) return;
	record.sessionId = sessionId;
	appendFileSync(
		record.logFile,
		`\n<torus:session id="${escapeAttr(sessionId)}" ts="${new Date().toISOString()}" />\n`,
	);
}

export function updateDelegation(
	id: string,
	snapshot: {
		text: string;
		turns: number;
		usage: {
			input: number;
			output: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: number;
		};
	},
): DelegationRecord | undefined {
	const record = registry.get(id);
	if (!record) return undefined;
	record.text = snapshot.text;
	record.turns = snapshot.turns;
	record.tokensIn = snapshot.usage.input;
	record.tokensOut = snapshot.usage.output;
	record.cacheRead = finiteOrZero(snapshot.usage.cacheRead);
	record.cacheWrite = finiteOrZero(snapshot.usage.cacheWrite);
	record.cost = finiteOrZero(snapshot.usage.cost);
	writeRunBeaconThrottled(recordBeacon(record));
	const cost = formatCost(snapshot.usage.cost, snapshot.usage.input + snapshot.usage.output > 0);
	appendFileSync(
		record.logFile,
		`\n--- turn ${snapshot.turns} (${snapshot.usage.input}/${snapshot.usage.output} tok${cost ? ` · ${cost}` : ""}) ---\n${indentChildText(snapshot.text)}\n`,
	);
	notifyUsageChange(record);
	return record;
}

/**
 * Child-produced text is shifted right two spaces in delegation logs so no
 * line can start at column 0 and impersonate a structural <torus:*> marker
 * that rehydrateFromLogs parses. The shift is exactly two spaces and nothing
 * else is altered, so parseLastTurnText can undo it byte-exactly.
 */
function indentChildText(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.length === 0 ? "" : `  ${line}`))
		.join("\n");
}

export function setDelegationModel(id: string, model: string): void {
	const record = registry.get(id);
	if (record) record.model = model;
}

export async function finishDelegation(
	id: string,
	ok: boolean,
	finalText: string,
	sessionId: string | null = null,
	opts?: { toast?: boolean },
): Promise<DelegationRecord | undefined> {
	const record = registry.get(id);
	if (!record) return undefined;
	record.status = ok ? "done" : "failed";
	record.finishedAt = Date.now();
	// Finished records keep a bounded head of the final text — rehydrate applies
	// the same cap, and an unbounded final pins memory for the life of the
	// session. readFullRecordText recovers the complete text from the log.
	record.text = finalText.slice(0, RECORD_TEXT_CAP);
	record.textTruncated = finalText.length > RECORD_TEXT_CAP;
	record.sessionId = sessionId;
	controls.delete(id);
	writeRunBeaconThrottled(recordBeacon(record));
	appendFileSync(
		record.logFile,
		`\n<torus:${record.status}${sessionId ? ` session="${escapeAttr(sessionId)}"` : ""} ts="${new Date().toISOString()}" />\n`,
	);
	const paneId = record.paneId;
	record.paneId = null;
	const late = lateToasts.get(id);
	if (late) {
		if (late.timer) clearTimeout(late.timer);
		lateToasts.delete(id);
	}
	if (opts?.toast !== false) {
		notifyDelegation(
			ok ? "done" : "failed",
			toastInfo(record),
			undefined,
			late?.notificationId ?? undefined,
		);
	}
	// notify before eviction: the record object carries the final cost even
	// once evictFinishedRecords drops it from the registry
	notifyUsageChange(record);
	evictFinishedRecords();
	await killPane(paneId);
	return record;
}

/** Normalize an optional usage-derived number; anything non-finite stores as 0. */
function finiteOrZero(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const REHYDRATE_LIMIT = 50;
/** Bounded head of the final text kept on finished and rehydrated records (chars). */
export const RECORD_TEXT_CAP = 4000;
/** Finished records retained in the registry; older ones evict (logs restore them). */
const FINISHED_RECORDS_LIMIT = 50;
/** Head bytes probed per candidate log before any full-file read. */
const REHYDRATE_HEAD_BYTES = 4096;
const TURN_RE =
	/--- turn (\d+) \((\d+)\/(\d+) tok(?: · (\$[0-9.]+))?\) ---\n([\s\S]*?)(?=\n--- turn |\n\[|$)/g;

/** A structural marker that finishDelegation or a stop request appends after the final turn block. */
const TRAILING_MARKER_RE = /\n*<torus:(?:done|failed|stop-requested)\b[^>]*\/>[ \t]*\n?$/;

/**
 * The complete final-turn text from a raw log: the last `--- turn N ---`
 * block with the writer's two-space shift undone and trailing structural
 * markers stripped. Only column-0 markers match, and indented child text can
 * never land at column 0, so genuine structure is removed while a child's
 * marker-shaped prose survives verbatim. Null when the log holds no turn
 * blocks. Logs written before the shift preserved leading whitespace lose
 * that indentation; their content still round-trips.
 */
export function parseLastTurnText(raw: string): string | null {
	let captured: string | null = null;
	for (const turn of raw.matchAll(TURN_RE)) captured = turn[5] ?? "";
	if (captured === null) return null;
	let text = captured;
	for (let stripped = text.replace(TRAILING_MARKER_RE, ""); stripped !== text; ) {
		text = stripped;
		stripped = text.replace(TRAILING_MARKER_RE, "");
	}
	return text
		.split("\n")
		.map((line) => (line.startsWith("  ") ? line.slice(2) : line))
		.join("\n")
		.trim();
}

/** A record's complete final text read back from its delegation log; null when the log is unreadable or turn-free. */
export function readFullRecordText(record: DelegationRecord): string | null {
	let raw: string;
	try {
		raw = readFileSync(record.logFile, "utf8");
	} catch {
		return null;
	}
	return parseLastTurnText(raw);
}

/**
 * The registry lives in process memory; a resumed session starts a fresh
 * engine with an empty registry even though logs and sub-agent sessions
 * persist on disk. Rebuild records from the project state dir's log files
 * so alt+t and the fleet work across resumes.
 */
export function rehydrateFromLogs(currentSessionId?: string): void {
	if (registry.size > 0) return;
	let files: string[];
	try {
		files = readdirSync(logsDir())
			.filter((file) => file.endsWith(".log"))
			.sort()
			.reverse();
	} catch {
		return;
	}

	let count = 0;
	const beacons = beaconsByLogFile();
	for (const file of files) {
		if (count >= REHYDRATE_LIMIT) break;
		// Only the head is read first: the start tag lives on line 1, so the
		// parent-session filter runs before any full-file read.
		const logFile = path.join(logsDir(), file);
		const head = readHead(logFile, REHYDRATE_HEAD_BYTES);
		if (head === null) continue;
		const start = parseTagStart(head);
		if (!start) continue;
		const parentSession = start.groups.parent;
		if (currentSessionId && parentSession !== currentSessionId) continue;
		let raw: string;
		try {
			raw = readFileSync(logFile, "utf8");
		} catch {
			continue;
		}
		const end = parseTagEnd(raw);
		const beacon = end ? undefined : beacons.get(logFile);
		// A live foreign beacon owns this run: the fleet renders its external
		// row, and rehydrating the log stem would duplicate it as "failed".
		if (beacon?.status === "running" && beacon.pid !== process.pid && pidAlive(beacon.pid)) {
			count += 1;
			continue;
		}
		let turns = 0;
		let tokensIn = 0;
		let tokensOut = 0;
		let cost = 0;
		for (const turn of raw.matchAll(TURN_RE)) {
			turns = Number(turn[1] ?? 0);
			tokensIn = Number(turn[2] ?? 0);
			tokensOut = Number(turn[3] ?? 0);
			const loggedCost = Number.parseFloat((turn[4] ?? "").replace("$", ""));
			cost = Number.isFinite(loggedCost) ? loggedCost : 0;
		}
		const fullText = parseLastTurnText(raw);
		// Chain-walk fallbacks append one <torus:pid> per respawned child; the
		// last tag is the live child, and it is the liveness key for the status
		// below and for reconcileOrphanedDelegations after this process dies.
		const pidTags = [...raw.matchAll(/^<torus:pid pid="(\d+)"[^>]*\/>/gm)];
		const childPid = pidTags.length > 0 ? Number(pidTags[pidTags.length - 1]?.[1]) : null;
		// One <torus:session> tag per chain-walk leg; the last tag is the leg
		// that was doing work, matching attachSessionId's latest-leg record.
		const sessionTags = [...raw.matchAll(/^<torus:session id="([^"]*)"[^>]*\/>/gm)];
		const sessionTag =
			sessionTags.length > 0 ? { 1: sessionTags[sessionTags.length - 1]?.[1] } : null;
		let startedAt = Date.parse(start.groups.ts);
		if (!Number.isFinite(startedAt)) {
			try {
				startedAt = statSync(logFile).mtimeMs;
			} catch {
				startedAt = Date.now();
			}
		}
		const id = path.basename(file, ".log");
		registry.set(id, {
			id,
			agent: start.groups.agent,
			model: start.groups.model,
			handle: normalizeHandle(start.groups.handle ?? null),
			status: end
				? end.groups.status === "done"
					? "done"
					: "failed"
				: beacon?.status === "done" || beacon?.status === "failed"
					? beacon.status
					: childPid !== null && pidAlive(childPid)
						? "running"
						: "failed",
			startedAt,
			turns,
			tokensIn,
			tokensOut,
			cacheRead: 0,
			cacheWrite: 0,
			cost,
			text: (fullText ?? "").slice(0, RECORD_TEXT_CAP),
			textTruncated: fullText !== null && fullText.length > RECORD_TEXT_CAP,
			logFile,
			sessionId: end?.groups.session ?? sessionTag?.[1] ?? null,
			parentSession,
			project: projectKeyFor(process.cwd()),
			paneId: null,
			...(childPid !== null ? { childPid } : {}),
			...(raw.includes("<torus:stop-requested ") ? { stopRequested: true } : {}),
		});
		notifyUsageChange(registry.get(id) as DelegationRecord);
		count += 1;
	}
}

interface StartFields {
	groups: {
		ts: string;
		agent: string;
		model: string;
		handle: string | null;
		parent: string | null;
	};
}

interface EndFields {
	groups: { status: string; session: string | null };
}

function tagAttrs(tag: string): Map<string, string> {
	const attrs = new Map<string, string>();
	for (const attr of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
		if (attr[1]) attrs.set(attr[1], attr[2] ?? "");
	}
	return attrs;
}

function parseTagStart(raw: string): StartFields | null {
	const match = raw.match(/^<torus:start ([^>]*?)\/>/m);
	if (!match) return null;
	const attrs = tagAttrs(match[1] ?? "");
	return {
		groups: {
			ts: attrs.get("ts") ?? "",
			agent: attrs.get("agent") ?? "unknown",
			model: attrs.get("model") ?? "unknown",
			handle: attrs.get("handle") ?? null,
			parent: attrs.get("parent") ?? null,
		},
	};
}

function parseTagEnd(raw: string): EndFields | null {
	const match = raw.match(/^<torus:(done|failed) ([^>]*?)\/>/m);
	if (!match) return null;
	const attrs = tagAttrs(match[2] ?? "");
	return { groups: { status: match[1] ?? "failed", session: attrs.get("session") ?? null } };
}

/** SessionShutdownEvent.reason: the values pi passes to session_shutdown. */
export type SessionEndReason = "quit" | "reload" | "new" | "resume" | "fork";

/**
 * Session-shutdown cleanup: kill every live delegation pane, drop late-toast
 * timers, and stop tracked controls so no pane, toast, or child outlives the
 * parent session.
 *
 * Replacement reasons (new/resume/fork) also retire the in-memory records:
 * the registry is process-shared and survives the extension rebind pi runs
 * for a session switch, and the incoming session_start's rehydrateFromLogs
 * bails on a non-empty registry — stale records would leak the outgoing
 * session's runs into torus_results and block rehydrating the incoming
 * session's own logs. Reload keeps the registry: same session, and its
 * in-flight records stay live.
 */
export async function registryShutdown(reason: SessionEndReason = "quit"): Promise<void> {
	for (const late of lateToasts.values()) {
		if (late.timer) clearTimeout(late.timer);
	}
	lateToasts.clear();
	lastBeaconWrites.clear();
	for (const control of [...controls.values()]) control.stop();
	controls.clear();
	const paneIds: string[] = [];
	for (const record of registry.values()) {
		if (record.paneId !== null) {
			paneIds.push(record.paneId);
			record.paneId = null;
		}
	}
	await Promise.all(paneIds.map((paneId) => killPane(paneId)));
	if (reason === "new" || reason === "resume" || reason === "fork") {
		registry.clear();
		externalRuns().length = 0;
	}
}

/**
 * Keep at most the FINISHED_RECORDS_LIMIT most recent finished records in the
 * registry — running records always stay, and evicted history remains
 * reconstructible from the log files on the next resume.
 */
function evictFinishedRecords(): void {
	const finished = [...registry.values()]
		.filter((entry) => entry.status !== "running")
		.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
	for (const record of finished.slice(FINISHED_RECORDS_LIMIT)) {
		registry.delete(record.id);
		lastBeaconWrites.delete(record.id);
	}
}
