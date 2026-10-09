/**
 * torus — delegation registry.
 *
 * Every running delegation is tracked here, tees its turn snapshots to a log
 * file (which tmux panes tail), and is listed by the /torus browser overlay.
 */

import { spawnSync } from "node:child_process";
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
import {
	formatCost,
	listDirUnion,
	projectKey,
	projectStateDir,
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
	logFile: string;
	sessionId: string | null;
	parentSession: string | null;
	/** Project key (state-dir identity) of the cwd the delegation runs in. */
	project: string;
	paneId: string | null;
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
	/** Server notification id of the fired interim toast, replaced by the finish toast. */
	notificationId: number | null;
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

/** Strip ANSI escape sequences and C1 control chars before text reaches the TUI. */
export function sanitizeRender(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b/g, "")
		.replace(/[\u0080-\u009F]/g, "");
}

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

export function stableColorIndex(name: string, buckets: number): number {
	let hash = 7;
	for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + (name.codePointAt(i) ?? 0)) | 0;
	return Math.abs(hash) % Math.max(1, buckets);
}

/** Absolute path of this project's delegation-log directory (state/--<project>--/logs). */
export function logsDir(cwd: string = process.cwd()): string {
	return path.join(projectStateDir(cwd), "logs");
}

/** Pre-project flat delegation-log directory (~/.torus/logs); read for old runs. */
export function legacyLogsDir(): string {
	return path.join(torusHome(), "logs");
}

/**
 * Newest-first (lexicographic) delegation log file paths, at most `n`. Pass
 * `dirs` to collect across several directories (dream reads this project's
 * logs plus the legacy flat dir); without it, only this project's dir scans.
 */
export function recentLogFiles(n: number, dirs?: string[]): string[] {
	const scanDirs = dirs ?? [logsDir()];
	const found: Array<{ dir: string; file: string }> = [];
	for (const dir of scanDirs) {
		try {
			for (const file of readdirSync(dir)) {
				if (file.endsWith(".log")) found.push({ dir, file });
			}
		} catch {}
	}
	return found
		.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
		.slice(0, n)
		.map((entry) => path.join(entry.dir, entry.file));
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
 * without one, or engine-child sessions).
 */
export function emitTorusCustom(
	message: TorusCustomMessage,
	options?: TorusCustomOptions,
): boolean {
	if (!senderState.sender) return false;
	senderState.sender(message, options);
	return true;
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
}

export function attachControl(id: string, control: DelegationControl): void {
	controls.set(id, control);
}

export function stopDelegation(id: string): boolean {
	const record = registry.get(id);
	if (record?.status !== "running") return false;
	appendFileSync(record.logFile, `\n<torus:stop-requested ts="${new Date().toISOString()}" />\n`);
	controls.get(id)?.stop();
	return true;
}

/** Steer log entry for a delegation action log; credential shapes redacted before flattening. */
export function steerLogLine(
	text: string,
	delivered: boolean,
	ts = new Date().toISOString(),
): string {
	const safe = redactSecrets(text).replace(/\s+/g, " ").slice(0, 200);
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
	runs.push({ startedAt: Date.now(), ...run });
	while (runs.length > EXTERNAL_RUNS_LIMIT) runs.shift();
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
const RUNS_PRUNE_MS = 6 * 60 * 60 * 1000;
const RUNS_PRUNE_COUNT = 200;

interface RunBeacon {
	id: string;
	agent: string;
	model: string;
	status: "running" | "done" | "failed";
	startedAt: number;
	pid: number;
	uid?: number;
	parentSession: string | null;
	sessionId: string | null;
	/** Project key of the delegation's cwd — the fleet is cross-project by design. */
	project: string;
	/** Action-log path so foreign runs can render output before the first turn. */
	logFile?: string;
}

function beaconFile(id: string): string {
	return path.join(RUNS_DIR, `${id}.json`);
}

function writeRunBeacon(beacon: RunBeacon): void {
	try {
		writeJson(beaconFile(beacon.id), { ...beacon, uid: process.getuid?.() });
	} catch {}
}

function pruneRunBeacons(now: number): void {
	try {
		const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
		const stale = files.filter((file) => {
			try {
				return now - statSync(path.join(RUNS_DIR, file)).mtimeMs > RUNS_PRUNE_MS;
			} catch {
				return true;
			}
		});
		const live = files.filter((f) => !stale.includes(f));
		const excess = Math.max(0, live.length - RUNS_PRUNE_COUNT);
		const oldest = live
			.map((f) => {
				try {
					return { f, m: statSync(path.join(RUNS_DIR, f)).mtimeMs };
				} catch {
					return { f, m: Infinity };
				}
			})
			.sort((a, b) => a.m - b.m)
			.slice(0, excess)
			.map((e) => e.f);
		for (const file of [...stale, ...oldest]) {
			try {
				rmSync(path.join(RUNS_DIR, file));
			} catch {}
		}
	} catch {}
}

function pidAlive(pid: number): boolean {
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
let externalRunsCache: { at: number; runs: RunBeacon[] } | null = null;

function foreignRunningBeacons(): RunBeacon[] {
	const now = Date.now();
	if (externalRunsCache && now - externalRunsCache.at < EXTERNAL_RUNS_CACHE_TTL_MS)
		return externalRunsCache.runs;
	const out: RunBeacon[] = [];
	let files: string[];
	try {
		files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const file of files) {
		let beacon: RunBeacon;
		try {
			beacon = JSON.parse(readFileSync(path.join(RUNS_DIR, file), "utf8")) as RunBeacon;
		} catch {
			continue;
		}
		const stem = file.slice(0, -".json".length);
		if (beacon.id !== stem) continue;
		const uid = process.getuid?.();
		if (typeof beacon.uid === "number" && typeof uid === "number" && beacon.uid !== uid) continue;
		if (beacon.pid === process.pid || beacon.status !== "running") continue;
		// Dead-pid beacons are reported in memory only — never rewrite a foreign
		// process's file. Consumers filter on state, so a failed entry drops out
		// of the fleet views exactly as the on-disk rewrite used to make it.
		out.push(pidAlive(beacon.pid) ? beacon : { ...beacon, status: "failed" });
	}
	externalRunsCache = { at: now, runs: out };
	return out;
}
/**
 * All run beacons (any status, same uid) keyed by action-log path — rehydrate
 * cross-references these so a live member's log is not rebuilt as a duplicate
 * "failed" record next to its authoritative external row.
 */
function beaconsByLogFile(): Map<string, RunBeacon> {
	const out = new Map<string, RunBeacon>();
	let files: string[];
	try {
		files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	const uid = process.getuid?.();
	for (const file of files) {
		let beacon: RunBeacon;
		try {
			beacon = JSON.parse(readFileSync(path.join(RUNS_DIR, file), "utf8")) as RunBeacon;
		} catch {
			continue;
		}
		if (beacon.id !== file.slice(0, -".json".length)) continue;
		if (typeof beacon.uid === "number" && typeof uid === "number" && beacon.uid !== uid) continue;
		if (typeof beacon.logFile === "string" && beacon.logFile.length > 0)
			out.set(beacon.logFile, beacon);
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
		.map(
			(beacon): ExternalRun => ({
				id: beacon.id,
				source: `torus-run:${beacon.pid}`,
				label: beacon.agent,
				model: beacon.model,
				sessionId: beacon.sessionId ?? undefined,
				logFile: beacon.logFile,
				state:
					beacon.status === "done" ? "done" : beacon.status === "failed" ? "failed" : "running",
				startedAt: beacon.startedAt,
			}),
		);
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
}

function tmuxPaneFor(logFile: string, agent: string, handle: string | null): string | null {
	if (process.env["TORUS_TMUX"] === "0" || !process.env["TMUX"]) return null;
	const exists = spawnSync("tmux", ["has-session"], { stdio: "ignore" });
	if (exists.status !== 0) return null;
	const split = spawnSync(
		"tmux",
		[
			"split-window",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
			"-l",
			"35%",
			`tail -n +1 -f ${shellQuote(logFile)}`,
		],
		{ stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
	);
	if (split.status !== 0 || !split.stdout.trim()) return null;
	const paneId = split.stdout.trim();
	spawnSync("tmux", ["select-pane", "-L"], { stdio: "ignore" });
	spawnSync("tmux", ["set-option", "-p", "-t", paneId, "pane-border-status", "top"], {
		stdio: "ignore",
	});
	spawnSync(
		"tmux",
		["select-pane", "-t", paneId, "-T", `torus: ${handle ? `@${handle}` : agent}`],
		{ stdio: "ignore" },
	);
	return paneId;
}

function killPane(paneId: string | null): void {
	if (!paneId) return;
	spawnSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
}

export function startDelegation(
	id: string,
	agent: string,
	model: string,
	parentSession: string | null = null,
	handle: string | null = null,
	cwd: string = process.cwd(),
): DelegationRecord {
	const dir = logsDir(cwd);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// chmod covers a pre-existing directory created with wider perms
	chmodSync(dir, 0o700);
	const logFile = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${agent}.log`);
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
		project: projectKey(cwd),
		paneId: tmuxPaneFor(logFile, agent, normalizedHandle),
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
	writeRunBeacon({
		id,
		agent,
		model,
		status: "running",
		startedAt: record.startedAt,
		pid: process.pid,
		parentSession,
		sessionId: null,
		project: projectKey(cwd),
		logFile,
	});
	appendFileSync(
		logFile,
		`<torus:start${formatStartAttrs(agent, model, normalizedHandle, parentSession)} />\n`,
	);
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
	if (record && !record.sessionId) record.sessionId = sessionId;
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
	writeRunBeacon({
		id: record.id,
		agent: record.agent,
		model: record.model,
		status: "running",
		startedAt: record.startedAt,
		pid: process.pid,
		parentSession: record.parentSession,
		sessionId: record.sessionId,
		project: record.project,
		logFile: record.logFile,
	});
	const cost = formatCost(snapshot.usage.cost, snapshot.usage.input + snapshot.usage.output > 0);
	appendFileSync(
		record.logFile,
		`\n--- turn ${snapshot.turns} (${snapshot.usage.input}/${snapshot.usage.output} tok${cost ? ` · ${cost}` : ""}) ---\n${indentChildText(snapshot.text)}\n`,
	);
	return record;
}

/**
 * Child-produced text is indented in delegation logs so no line can start at
 * column 0 and impersonate a structural <torus:*> marker that
 * rehydrateFromLogs parses.
 */
function indentChildText(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.length === 0 ? "" : `  ${line.replace(/^\s+/, "")}`))
		.join("\n");
}

export function setDelegationModel(id: string, model: string): void {
	const record = registry.get(id);
	if (record) record.model = model;
}

export function finishDelegation(
	id: string,
	ok: boolean,
	finalText: string,
	sessionId: string | null = null,
	opts?: { toast?: boolean },
): DelegationRecord | undefined {
	const record = registry.get(id);
	if (!record) return undefined;
	record.status = ok ? "done" : "failed";
	record.finishedAt = Date.now();
	record.text = finalText;
	record.sessionId = sessionId;
	controls.delete(id);
	writeRunBeacon({
		id: record.id,
		agent: record.agent,
		model: record.model,
		status: record.status,
		startedAt: record.startedAt,
		pid: process.pid,
		parentSession: record.parentSession,
		sessionId,
		project: record.project,
		logFile: record.logFile,
	});
	appendFileSync(
		record.logFile,
		`\n<torus:${record.status}${sessionId ? ` session="${escapeAttr(sessionId)}"` : ""} ts="${new Date().toISOString()}" />\n`,
	);
	killPane(record.paneId);
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
	return record;
}

/** Normalize an optional usage-derived number; anything non-finite stores as 0. */
function finiteOrZero(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const REHYDRATE_LIMIT = 50;
const TURN_RE =
	/--- turn (\d+) \((\d+)\/(\d+) tok(?: · (\$[0-9.]+))?\) ---\n([\s\S]*?)(?=\n--- turn |\n\[|$)/g;

/**
 * The registry lives in process memory; a resumed session starts a fresh
 * engine with an empty registry even though logs and sub-agent sessions
 * persist on disk. Logs live under per-project state dirs with a legacy flat
 * fallback (~/.torus/logs), so both are scanned. Rebuild records from the
 * log files so alt+t and the fleet work across resumes.
 */
export function rehydrateFromLogs(currentSessionId?: string): void {
	if (registry.size > 0) return;
	let files: string[];
	try {
		files = listDirUnion(logsDir(), legacyLogsDir())
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
		// union order is lost — prefer the project dir, then the legacy flat dir
		let logFile = path.join(logsDir(), file);
		let raw: string | undefined;
		for (const candidate of [logFile, path.join(legacyLogsDir(), file)]) {
			try {
				raw = readFileSync(candidate, "utf8");
				logFile = candidate;
				break;
			} catch {}
		}
		if (raw === undefined) continue;
		const start = parseTagStart(raw) ?? legacyStart(raw);
		if (!start) continue;
		const parentSession = start.groups.parent;
		if (currentSessionId && parentSession !== currentSessionId) continue;
		const end = parseTagEnd(raw) ?? legacyEnd(raw);
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
		let text = "";
		for (const turn of raw.matchAll(TURN_RE)) {
			turns = Number(turn[1] ?? 0);
			tokensIn = Number(turn[2] ?? 0);
			tokensOut = Number(turn[3] ?? 0);
			const loggedCost = Number.parseFloat((turn[4] ?? "").replace("$", ""));
			cost = Number.isFinite(loggedCost) ? loggedCost : 0;
			text = (turn[5] ?? "").trim();
		}
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
					: "failed",
			startedAt,
			turns,
			tokensIn,
			tokensOut,
			cacheRead: 0,
			cacheWrite: 0,
			cost,
			text: text.slice(0, 4000),
			logFile,
			sessionId: end?.groups.session ?? null,
			parentSession,
			project: projectKey(process.cwd()),
			paneId: null,
		});
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

function legacyStart(raw: string): StartFields | null {
	const match = raw.match(
		/^\[([^\]]+)\] delegate (\S+) \(([^)]+)\) start(?: · @(\S+))?(?: · parent (\S+))?/m,
	);
	if (!match) return null;
	return {
		groups: {
			ts: match[1] ?? "",
			agent: match[2] ?? "unknown",
			model: match[3] ?? "unknown",
			handle: match[4] ?? null,
			parent: match[5] ?? null,
		},
	};
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

function legacyEnd(raw: string): EndFields | null {
	const match = raw.match(/^\[([^\]]+)\] (done|failed)(?: · session (\S+))?\s*$/m);
	if (!match) return null;
	return { groups: { status: match[2] ?? "failed", session: match[3] ?? null } };
}
