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
	/** Origin tag (`torus-team:<id>` for team members); plain delegations carry none. */
	source?: string;
	/** Display label (a member's name); plain delegations render the agent name. */
	label?: string;
	memberStatus?: "working" | "idle" | "stopped";
	/** Seconds of active (non-idle) work; the displayed age freezes while idle. */
	activeSeconds?: number;
	/** When activeSeconds was last computed (now-active members tick from this). */
	activeUpdatedAt?: number;
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
 * <torus:pid> tag (the log fallback parses it back), and carried on run
 * beacons. A chain walk's model fallbacks respawn children, so a later attach
 * with a different pid replaces the record's value and appends a second tag —
 * rehydrate keeps the last one.
 */
export function attachChildPid(id: string, pid: number): void {
	const record = registry.get(id);
	if (!record || record.childPid === pid) return;
	record.childPid = pid;
	appendFileSync(record.logFile, `\n<torus:pid pid="${pid}" ts="${new Date().toISOString()}" />\n`);
	// Unthrottled: child liveness is a resumption-critical field, and the
	// same-status window could otherwise leave the store without it for the
	// run's first 10 seconds — exactly the window a crashed run never escapes.
	writeRunBeacon(recordBeacon(record));
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

/**
 * Age in seconds for a unified run record: banked active time for member
 * runs (the clock freezes while idle and resumes from activeUpdatedAt),
 * wall clock since start otherwise.
 */
export function externalRunAgeSeconds(run: RunRecord): number {
	if (run.activeSeconds === undefined)
		return Math.max(0, Math.round((Date.now() - run.startedAt) / 1000));
	const elapsed =
		run.memberStatus === "idle"
			? 0
			: Math.max(0, Date.now() - (run.activeUpdatedAt ?? run.startedAt));
	return run.activeSeconds + Math.floor(elapsed / 1000);
}

const RUNS_DIR = path.join(torusHome(), "runs");
/** Finished run records are kept this long past their finish; running records are count-capped, not aged. */
const RUNS_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const RUNS_PRUNE_COUNT = 200;
/** A "running" beacon with a dead writer pid is a zombie this long after its last write. */
const RUNS_ZOMBIE_MS = 10 * 60 * 1000;

/**
 * The on-disk run record: one JSON file per run in RUNS_DIR, written by the
 * one registration path (startDelegation; team members register through it
 * with their origin fields). Every field beyond the identity core is optional
 * so identity-only files written by older binaries load cleanly; the scan
 * zeroes missing stats instead of rejecting the file.
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
		...(record.source !== undefined ? { source: record.source } : {}),
		...(record.label !== undefined ? { label: record.label } : {}),
		...(record.memberStatus !== undefined ? { memberStatus: record.memberStatus } : {}),
		...(record.activeSeconds !== undefined ? { activeSeconds: record.activeSeconds } : {}),
		...(record.activeUpdatedAt !== undefined ? { activeUpdatedAt: record.activeUpdatedAt } : {}),
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
 * Beacon-write throttle state: last status, member status, and time written
 * per record. A running delegation updates every turn, but a same-status
 * beacon carries no new fleet information — rewriting it each turn is 3 fs
 * ops for nothing. A memberStatus flip (working↔idle) IS fleet information:
 * the strip renders the idle rest, so it bypasses the window like a status
 * change does.
 */
const BEACON_MIN_INTERVAL_MS = 10_000;
const lastBeaconWrites = new Map<
	string,
	{ status: RunRecord["status"]; memberStatus?: RunRecord["memberStatus"]; at: number }
>();

function writeRunBeaconThrottled(record: RunRecordWrite): void {
	const now = Date.now();
	const last = lastBeaconWrites.get(record.id);
	if (
		last &&
		last.status === record.status &&
		last.memberStatus === record.memberStatus &&
		now - last.at < BEACON_MIN_INTERVAL_MS
	)
		return;
	writeRunBeacon(record);
	lastBeaconWrites.set(record.id, {
		status: record.status,
		memberStatus: record.memberStatus,
		at: now,
	});
}

/**
 * Read-through loader for the run store: a record absent from the in-memory
 * cache — evicted by the 50-record bound, or written by another process —
 * reloads its run JSON on demand. Identity-only files load with zeroed
 * stats, exactly like the scan path. Undefined when no file exists.
 */
function loadRunRecord(id: string): RunRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(beaconFile(id), "utf8")) as RunRecord;
		if (record.id !== id) return undefined;
		record.turns ??= 0;
		record.tokensIn ??= 0;
		record.tokensOut ??= 0;
		record.cacheRead ??= 0;
		record.cacheWrite ??= 0;
		return record;
	} catch {
		return undefined;
	}
}

/**
 * The unified update path: patch one run by id, whether it lives in the
 * in-memory cache or only in the store. The patch merges over the current
 * record and reaches the beacon file through the same throttled write, so
 * member status and active-time bookkeeping survive evictions and process
 * boundaries. True when a record was found in cache or store.
 */
export function updateRunRecord(id: string, patch: Partial<RunRecord>): boolean {
	const record = registry.get(id);
	if (record) {
		Object.assign(record, patch);
		writeRunBeaconThrottled(recordBeacon(record));
		return true;
	}
	const disk = loadRunRecord(id);
	if (!disk) return false;
	writeRunBeaconThrottled({ ...disk, ...patch });
	return true;
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

/** Test-only: drop the beacon-scan TTL cache so a freshly planted file is visible immediately. */
export function expireBeaconCacheForTesting(): void {
	externalRunsCache = null;
}

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

/** A run record as listExternalRuns returns it: display fields guaranteed. */
export type RunRecordView = RunRecord & { source: string; label: string };

/**
 * THE list API over unified run records: the in-memory registry cache (the
 * freshest copy of every record this process drives) deduplicated against
 * the beacon store's foreign running records — the beacon IS the record now,
 * so a delegation's own beacon and its registry entry merge by id instead of
 * listing twice (local wins: memory is fresher; disk-only fields survive).
 * Foreign running beacons are session-scoped, and one whose writer pid is
 * dead reports failed in memory only. Fleet views that also render registry
 * rows filter the ids they already show.
 */
export function listExternalRuns(): RunRecordView[] {
	const current = getCurrentSession();
	// Display defaults for identity-only records: plain runs render a
	// synthetic torus-run source and the agent as label.
	const fill = (record: RunRecord): RunRecordView => ({
		...record,
		source: record.source ?? `torus-run:${record.pid}`,
		label: record.label ?? record.agent,
	});
	const local = new Map<string, RunRecordView>();
	for (const record of registry.values()) local.set(record.id, fill(recordBeacon(record)));
	const foreignOnly: RunRecordView[] = [];
	for (const beacon of foreignRunningBeacons()) {
		if (current !== null && beacon.parentSession !== current) continue;
		const cached = local.get(beacon.id);
		// Local-over-disk merge: memory is fresher; disk-only fields survive.
		if (cached) local.set(beacon.id, { ...beacon, ...cached });
		else foreignOnly.push(fill(beacon));
	}
	return [...local.values(), ...foreignOnly].sort((a, b) => b.startedAt - a.startedAt);
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
	lateToasts.clear();
	lastBeaconWrites.clear();
	externalRunsCache = null;
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

/** Origin fields for runs registered against an existing log (team members). */
export interface DelegationStartOptions {
	/** Origin tag landing on the record and its beacon (`torus-team:<id>`). */
	source?: string;
	/** Display label landing on the record and its beacon (the member name). */
	label?: string;
	/** Existing action log to register against (the team transcript); skips creating a logsDir log. */
	logFile?: string;
}

export async function startDelegation(
	id: string,
	agent: string,
	model: string,
	parentSession: string | null = null,
	handle: string | null = null,
	cwd: string = process.cwd(),
	opts: DelegationStartOptions = {},
): Promise<DelegationRecord> {
	let logFile: string;
	if (opts.logFile) {
		// Registered against an existing log (the team transcript): the member
		// record points there per its origin — delegations keep logsDir() logs.
		// The transcript's dir may not exist yet (team-runtime creates it when
		// the supervisor spawns), and the start tag below must not race it.
		logFile = opts.logFile;
		mkdirSync(path.dirname(logFile), { recursive: true });
	} else {
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
		logFile = path.join(
			dir,
			`${new Date().toISOString().replace(/[:.]/g, "-")}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}-${agent}.log`,
		);
		// delegation logs capture tool args — enforce owner-only from birth
		appendFileSync(logFile, "");
		chmodSync(logFile, 0o600);
	}
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
		...(opts.source !== undefined ? { source: opts.source } : {}),
		...(opts.label !== undefined ? { label: opts.label } : {}),
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
	// leg's tag persists in the log so the log fallback recovers the last one
	// for an un-ended log (end tags carry the final id, but an orphaned run
	// never writes one — and spend folding keys on the transcript it names).
	if (record.sessionId === sessionId) return;
	record.sessionId = sessionId;
	appendFileSync(
		record.logFile,
		`\n<torus:session id="${escapeAttr(sessionId)}" ts="${new Date().toISOString()}" />\n`,
	);
	// Unthrottled, same reason as attachChildPid: orphan reconciliation keys on
	// this field, and a run that dies before the next turn write must still
	// recover it from the store.
	writeRunBeacon(recordBeacon(record));
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

/** A store record is recoverable by this user: untagged, or tagged with our uid — the scan's gate. */
function ownUidRecord(record: RunRecord): boolean {
	const uid = process.getuid?.();
	return !(typeof record.uid === "number" && typeof uid === "number" && record.uid !== uid);
}

/**
 * Stats presence is the store-backed marker: identity-only files written by
 * older binaries carry none, so their runs recover through the log fallback.
 * Zeroes count — a fresh run's beacon legitimately holds turns 0 — the
 * trigger is absent fields, never empty ones.
 */
function hasRunStats(record: RunRecord): boolean {
	return (
		record.turns !== undefined && record.tokensIn !== undefined && record.tokensOut !== undefined
	);
}

/**
 * A recovered store record as a registry-cache DelegationRecord. paneId is
 * always dropped: the pane lived in the writer process and died with it.
 */
function beaconToRecord(beacon: RunRecord): DelegationRecord {
	return {
		id: beacon.id,
		agent: beacon.agent,
		model: beacon.model,
		handle: normalizeHandle(beacon.handle),
		status: beacon.status,
		startedAt: beacon.startedAt,
		...(beacon.finishedAt !== undefined ? { finishedAt: beacon.finishedAt } : {}),
		turns: beacon.turns ?? 0,
		tokensIn: beacon.tokensIn ?? 0,
		tokensOut: beacon.tokensOut ?? 0,
		cacheRead: beacon.cacheRead ?? 0,
		cacheWrite: beacon.cacheWrite ?? 0,
		cost: beacon.cost ?? 0,
		text: beacon.text ?? "",
		...(beacon.textTruncated !== undefined ? { textTruncated: beacon.textTruncated } : {}),
		logFile: beacon.logFile ?? "",
		sessionId: beacon.sessionId,
		parentSession: beacon.parentSession,
		project: beacon.project,
		paneId: null,
		...(beacon.childPid !== undefined ? { childPid: beacon.childPid } : {}),
		...(beacon.stopRequested ? { stopRequested: true } : {}),
		...(beacon.source !== undefined ? { source: beacon.source } : {}),
		...(beacon.label !== undefined ? { label: beacon.label } : {}),
		...(beacon.memberStatus !== undefined ? { memberStatus: beacon.memberStatus } : {}),
		...(beacon.activeSeconds !== undefined ? { activeSeconds: beacon.activeSeconds } : {}),
		...(beacon.activeUpdatedAt !== undefined ? { activeUpdatedAt: beacon.activeUpdatedAt } : {}),
	};
}

/** Land a recovered store record in the registry cache and notify, as the log scan does. */
function cacheRecoveredRecord(beacon: RunRecord): DelegationRecord {
	const record = beaconToRecord(beacon);
	registry.set(record.id, record);
	notifyUsageChange(record);
	return record;
}

/**
 * The first log in the project logs dir that belongs to the session but has
 * no run record in the store: a pre-store run whose beacon never existed or
 * was pruned with the 7-day finished horizon. Head probe only — the full
 * parse is the log fallback's job.
 */
function firstBeaconlessSessionRun(sessionId: string, knownStems: Set<string>): string | null {
	let files: string[];
	try {
		files = readdirSync(logsDir())
			.filter((file) => file.endsWith(".log"))
			.sort()
			.reverse();
	} catch {
		return null;
	}
	for (const file of files) {
		const stem = path.basename(file, ".log");
		if (knownStems.has(stem)) continue;
		const head = readHead(path.join(logsDir(), file), REHYDRATE_HEAD_BYTES);
		const start = head === null ? null : parseTagStart(head);
		if (start && (start.groups.parent ?? null) === sessionId) return stem;
	}
	return null;
}

/**
 * The un-zeroed store record for the recovery gate: loadRunRecord fills
 * absent stats with 0, which would erase exactly the identity-only signal
 * the fallback trigger reads.
 */
function rawRunRecord(id: string): RunRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(beaconFile(id), "utf8")) as RunRecord;
		return record.id === id ? record : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Store-first recovery for one run. A live record is returned untouched:
 * memory is fresher than the throttled store write. Otherwise the beacon
 * store's stats-bearing record of ours is the primary path and the log
 * parser never runs for it. The log scan is the legacy fallback for pre-store
 * runs only: an identity-only store record, or no store record at all once
 * finished beacons prune. The scan's own no-clobber guard keeps that a no-op
 * once anything is cached — pre-store recovery is a session-start shape,
 * where the registry is still empty.
 */
export function recoverRun(id: string, sessionId?: string): DelegationRecord | undefined {
	const live = registry.get(id);
	if (live) return live;
	const disk = rawRunRecord(id);
	if (disk && hasRunStats(disk) && ownUidRecord(disk) && disk.logFile) {
		return cacheRecoveredRecord(disk);
	}
	rehydrateFromLogs(sessionId);
	return registry.get(id);
}

/**
 * Session-start recovery, store-first. Every stats-bearing run record of the
 * session lands in the registry cache from the beacon store and never
 * touches the log parser; pre-store runs (identity-only beacons, or logs with
 * no store record) recover through the log scan via recoverRun's single
 * fallback call, keyed on an identity-only beacon or a beacon-less session
 * log. A live foreign run is skipped from the cache — its external row
 * renders it, exactly as the log scan's live-beacon rule does.
 *
 * The store records land AFTER the fallback pass on purpose: the pass is a
 * whole-session scan and also parses store-backed logs, so caching last
 * means the store's copy wins and its cache counters — which exist only in
 * the store — survive even a mixed-session fallback.
 */
export function recoverSession(sessionId: string): void {
	// Same guard as the log scan: a live registry (reload keeps its records)
	// is never overwritten by recovery.
	if (registry.size > 0) return;
	const beacons = readRunBeacons().filter((record) => record.parentSession === sessionId);
	const storeBacked = beacons.filter((record) => hasRunStats(record) && record.logFile);
	// The log scan derives ids from log filename stems, which differ from a
	// store record's id — a run's log stem is <ts>-<id>-<agent>. So the
	// beacon-less probe keys on the session beacons' logFile stems, and the
	// store phase below replaces any stem-id copy the fallback pass made of a
	// store-backed run.
	const knownStems = new Set(
		beacons.flatMap((record) =>
			typeof record.logFile === "string" && record.logFile.length > 0
				? [path.basename(record.logFile, ".log")]
				: [],
		),
	);
	const preStoreId =
		beacons.find((record) => !hasRunStats(record))?.id ??
		firstBeaconlessSessionRun(sessionId, knownStems);
	if (typeof preStoreId === "string") recoverRun(preStoreId, sessionId);
	for (const beacon of storeBacked) {
		if (beacon.status === "running" && beacon.pid !== process.pid && pidAlive(beacon.pid)) {
			continue;
		}
		for (const [existingId, existing] of registry) {
			if (existingId !== beacon.id && existing.logFile === beacon.logFile) {
				registry.delete(existingId);
			}
		}
		cacheRecoveredRecord(beacon);
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
	}
}

/**
 * Keep at most the FINISHED_RECORDS_LIMIT most recent finished records in the
 * registry — running records always stay, and evicted history remains
 * reconstructible from the run store on the next resume (the log scan covers
 * pre-store runs).
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
