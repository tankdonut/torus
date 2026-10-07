import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	childExtensionArgs,
	type EngineTally,
	reduceEngineEvent,
	resolveEngineBin,
	sessionIdFromState,
} from "./engine-child.js";
import { stripFrontmatter } from "./frontmatter.js";
import { readJson, sleep, writeJson } from "./fsutil.js";
import { DEFAULT_MEMBER_MODEL } from "./providers/index.js";
import { AGENT_NAME_RE, repoRoot } from "./registry.js";
import { AGENTS, resolveModels } from "./roster/index.js";
import { RpcChild } from "./rpc.js";

const TEAMS_ROOT = path.join(homedir(), ".torus", "teams");
const POLL_MS = 2_000;

export interface MemberSpec {
	name: string;
	agent: string;
	model?: string;
	cwd?: string;
}

export interface MemberHandle {
	stop: () => void;
	forceKill: () => void;
	mailboxDir: string;
	readonly exited: Promise<number>;
}

export function teamDir(teamId: string): string {
	return path.join(TEAMS_ROOT, teamId);
}

export interface TeamSpec {
	name: string;
	objective: string;
	members: Array<{ name: string; agent: string; model?: string }>;
	status?: "active" | "shutdown";
	/** Session that created the team — member delegation records re-parent to it on respawn. */
	parentSession?: string | null;
	/** Opt-in: members are taught the atomic self-claim CLI protocol in their objective. Default off — absent behaves as false. */
	selfClaim?: boolean;
}

export function writeTeamSpec(teamId: string, spec: TeamSpec): void {
	writeJson(path.join(teamDir(teamId), "team.json"), { id: teamId, ...spec });
}

export function readTeamSpec(teamId: string): (TeamSpec & { id: string }) | null {
	const parsed = readJson<Partial<TeamSpec> | null>(path.join(teamDir(teamId), "team.json"), null);
	if (typeof parsed !== "object" || parsed === null) return null;
	if (
		typeof parsed.name !== "string" ||
		typeof parsed.objective !== "string" ||
		!Array.isArray(parsed.members)
	)
		return null;
	return parsed as TeamSpec & { id: string };
}

export function markTeamStatus(teamId: string, status: "active" | "shutdown"): void {
	const spec = readTeamSpec(teamId);
	if (!spec) return;
	writeTeamSpec(teamId, { ...spec, status });
}

export function listTeamIds(): string[] {
	try {
		return readdirSync(TEAMS_ROOT).filter((dir) =>
			existsSync(path.join(TEAMS_ROOT, dir, "team.json")),
		);
	} catch {
		return [];
	}
}

export function memberMailbox(teamId: string, member: string): string {
	const dir = path.join(teamDir(teamId), "mailboxes", member);
	mkdirSync(dir, { recursive: true });
	for (const file of ["inbox.md", "outbox.md"]) {
		const target = path.join(dir, file);
		if (!existsSync(target)) writeFileSync(target, "", "utf8");
	}
	return dir;
}

export function deliverMail(teamId: string, member: string, from: string, text: string): string {
	const dir = memberMailbox(teamId, member);
	appendFileSync(
		path.join(dir, "inbox.md"),
		`\n[${new Date().toISOString()}] FROM ${from}:\n${text}\n`,
		"utf8",
	);
	return path.join(dir, "inbox.md");
}

export function tasksFile(teamId: string): string {
	return path.join(teamDir(teamId), "tasks.json");
}

export interface Task {
	id: string;
	subject: string;
	assignee: string | null;
	status: string;
	updatedAt: string;
	/** Task ids that must complete before this task can be claimed (in_progress). */
	dependsOn?: string[];
}

interface TasksFile {
	tasks: Task[];
	nextId: number;
}

function maxTaskId(tasks: TasksFile["tasks"]): number {
	let max = 0;
	for (const task of tasks) {
		const match = /^t(\d+)$/.exec(task.id);
		if (match) {
			const n = Number(match[1]);
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max;
}

export function readTasksFile(teamId: string): TasksFile {
	const parsed = readJson<Partial<TasksFile>>(tasksFile(teamId), {});
	// A member hand-editing tasks.json can leave dependsOn as anything — only
	// an array is a dependency list; anything else reads as "no dependencies".
	const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((task) => ({
		...task,
		dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : undefined,
	}));
	return {
		tasks,
		nextId: typeof parsed.nextId === "number" ? parsed.nextId : 1 + maxTaskId(tasks),
	};
}

export function writeTasksFile(teamId: string, file: TasksFile): void {
	writeJson(tasksFile(teamId), { tasks: file.tasks, nextId: file.nextId });
}

/**
 * Derive which tasks are blocked by unmet dependencies. A task is blocked
 * when its dependsOn names at least one OTHER task that exists on the list
 * and is not completed; the map carries the blocking ids per blocked task.
 * Unknown dependency ids never block: they cannot complete, but a raw member
 * edit can leave one behind (a typo must not become a permanent lock) —
 * unknown ids are surfaced by create-time validation instead. A
 * self-reference is likewise not blocking (create rejects it). Pure: no I/O.
 */
export function blockedTasks(tasks: Task[]): Map<string, string[]> {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const blocked = new Map<string, string[]>();
	for (const task of tasks) {
		if (!task.dependsOn || task.dependsOn.length === 0) continue;
		const blockers = task.dependsOn.filter(
			(dep) => dep !== task.id && byId.has(dep) && byId.get(dep)?.status !== "completed",
		);
		if (blockers.length > 0) blocked.set(task.id, blockers);
	}
	return blocked;
}

/**
 * Find a dependency cycle: walk dependsOn edges depth-first from every
 * task; the first revisit of a node on the current walk yields the chain
 * (e.g. ["t2", "t4", "t2"]). Unknown ids are leaves — they cannot form a
 * cycle. Pure: no I/O.
 */
export function dependencyCycle(tasks: Task[]): string[] | null {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const settled = new Set<string>();
	for (const start of tasks) {
		if (settled.has(start.id)) continue;
		const path: string[] = [];
		const onPath = new Set<string>();
		const visit = (id: string): string[] | null => {
			if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
			const task = byId.get(id);
			if (!task || settled.has(id)) return null;
			onPath.add(id);
			path.push(id);
			for (const dep of task.dependsOn ?? []) {
				const cycle = visit(dep);
				if (cycle) return cycle;
			}
			path.pop();
			onPath.delete(id);
			settled.add(id);
			return null;
		};
		const cycle = visit(start.id);
		if (cycle) return cycle;
	}
	return null;
}

/**
 * Serialized read-modify-write for the shared tasklist. Members edit
 * tasks.json via bash while the lead uses team_task_update; an unlocked RMW
 * loses one side's update. A directory lock (rename-atomic) serializes both
 * this helper and itself across processes; stale locks are taken over after
 * STALE_LOCK_MS. Raw member writes bypass the lock entirely, so the RMW also
 * compares the file's mtime before read and before write: a change means
 * someone wrote underneath us and the mutation re-runs against a fresh read
 * (bounded to CAS_RETRIES, then last-writer-wins). Mutators must therefore be
 * re-runnable — they may execute more than once.
 */
const STALE_LOCK_MS = 5_000;
const CAS_RETRIES = 3;

function mtimeOf(file: string): number | null {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

export function updateTasksFile(
	teamId: string,
	// biome-ignore lint/suspicious/noConfusingVoidType: mutator returns a replacement or mutates in place
	mutate: (file: TasksFile) => TasksFile | void,
): TasksFile {
	const lockDir = `${tasksFile(teamId)}.lock`;
	const deadline = Date.now() + STALE_LOCK_MS;
	for (;;) {
		try {
			mkdirSync(lockDir);
			break;
		} catch {
			try {
				const stat = statSync(lockDir);
				if (Date.now() - stat.mtimeMs > STALE_LOCK_MS)
					rmSync(lockDir, { recursive: true, force: true });
			} catch {
				// lock vanished between stat and now — retry immediately
			}
			if (Date.now() > deadline) rmSync(lockDir, { recursive: true, force: true });
			sleepSync(20);
		}
	}
	try {
		const file = tasksFile(teamId);
		for (let attempt = 0; ; attempt++) {
			const before = mtimeOf(file);
			const current = readTasksFile(teamId);
			const next = mutate(current) ?? current;
			if (mtimeOf(file) !== before && attempt < CAS_RETRIES) continue;
			writeTasksFile(teamId, next);
			return next;
		}
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function rolePromptFor(spec: MemberSpec, teamId: string, objective: string): Promise<string> {
	const agentsDir = path.resolve(import.meta.dirname, "../agents");
	let raw: string | null = null;
	if (AGENT_NAME_RE.test(spec.agent)) {
		try {
			raw = readFileSync(path.join(agentsDir, `${spec.agent}.md`), "utf8");
		} catch {
			raw = null;
		}
	}
	const body = raw ? stripFrontmatter(raw) : `ROLE: ${spec.agent}`;
	const mailRoot = path.join(teamDir(teamId), "mailboxes");
	return `${body.trim()}

<team-protocol>
You are a persistent team member "${spec.name}" (role: ${spec.agent}) on team ${teamId}.

TEAM OBJECTIVE: ${objective}

YOUR CHANNELS (plain files — use read/write via your tools):
- Inbox (work arrives here): ${path.join(mailRoot, spec.name, "inbox.md")}
- Outbox (your reports go here — append, never overwrite): ${path.join(mailRoot, spec.name, "outbox.md")}
- Shared tasklist (JSON; claim/complete your tasks by updating it via bash/read+write): ${tasksFile(teamId)} — when editing it, serialize with: flock ${tasksFile(teamId)} bash -c '<your read-edit-write>'
- Other members' inboxes: ${mailRoot}/<member>/inbox.md — message them by appending there.

PROTOCOL each cycle: finish current instruction, then read your inbox for new messages. Act on each message in order. Report outcomes by appending to your outbox (one block per report, with a timestamp line). Update the tasklist when you claim or complete work. Do not ask for permission to act within the objective — surface blockers in your outbox instead.
</team-protocol>`;
}

/**
 * Spawns a persistent team member: a long-lived RPC-mode engine child driven
 * by a supervisor loop. Each cycle: run current instruction, drain new inbox
 * content into the next prompt, publish outbox deltas to the log. Runs until
 * stopped (control.stop kills the child; the loop exits on child exit).
 */
export function memberModelCandidates(spec: MemberSpec): string[] {
	const chain = AGENTS.find((a) => a.name === spec.agent)?.chain ?? "primary";
	return [...new Set([spec.model ?? DEFAULT_MEMBER_MODEL, ...resolveModels(chain)])];
}

export function spawnMember(
	teamId: string,
	spec: MemberSpec,
	objective: string,
	onState: (state: {
		status: "starting" | "working" | "idle" | "stopped";
		sessionId: string | null;
	}) => void,
	/** Outbox delta; `handshake` marks a pre-mail bootstrap write ("ready"). */
	onReport: (text: string, handshake: boolean) => void,
	onStats?: (stats: {
		turns: number;
		tokensIn: number;
		tokensOut: number;
		cacheRead: number;
		cacheWrite: number;
		/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
		cost: number;
		/** Last child text snapshot; feeds the delegation-registry turn log. */
		text: string;
	}) => void,
): MemberHandle {
	const mailboxDir = memberMailbox(teamId, spec.name);
	const inboxFile = path.join(mailboxDir, "inbox.md");
	const outboxFile = path.join(mailboxDir, "outbox.md");
	const logFile = path.join(teamDir(teamId), `${spec.name}.log`);
	mkdirSync(teamDir(teamId), { recursive: true });

	const root = repoRoot();
	const modelCandidates = memberModelCandidates(spec);
	const headModel = spec.model ?? DEFAULT_MEMBER_MODEL;

	let settleResolve: (() => void) | null = null;
	let settleLatch = new Promise<void>((r) => {
		settleResolve = r;
	});
	let sessionId: string | null = null;
	let stopped = false;

	const engineBin = resolveEngineBin();
	const tally: EngineTally = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
	};
	let modelIndex = 0;
	let turnsAtSpawn = 0;
	let resolveExited: (code: number) => void = () => {};
	const exitedAll = new Promise<number>((r) => {
		resolveExited = r;
	});

	const createChild = (model: string): RpcChild =>
		new RpcChild(
			engineBin,
			["--mode", "rpc", "--model", model, ...childExtensionArgs(root)],
			spec.cwd ?? process.cwd(),
			{
				onEvent: (event) => {
					const before = tally.turns;
					reduceEngineEvent(event, tally);
					if (tally.turns > before) {
						onStats?.({
							turns: tally.turns,
							tokensIn: tally.tokensIn,
							tokensOut: tally.tokensOut,
							cacheRead: tally.cacheRead,
							cacheWrite: tally.cacheWrite,
							cost: tally.cost,
							text: tally.text.slice(0, 2000),
						});
					}
				},
				onSettled: () => settleResolve?.(),
			},
		);
	let child = createChild(headModel);

	// Best-effort: the supervisor is a fire-and-forget IIFE, so a throw here
	// (e.g. team dir deleted mid-shutdown) would be an unhandled rejection.
	const appendLog = (line: string): void => {
		try {
			appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, "utf8");
		} catch {
			// log target gone — nothing further to do
		}
	};

	const readDelta = (file: string, cursorRef: { value: number }, cursorFile?: string): string => {
		try {
			const content = readFileSync(file, "utf8");
			if (content.length < cursorRef.value) cursorRef.value = 0;
			if (content.length <= cursorRef.value) return "";
			const delta = content.slice(cursorRef.value);
			cursorRef.value = content.length;
			if (cursorFile) {
				try {
					writeFileSync(cursorFile, String(cursorRef.value), "utf8");
				} catch {}
			}
			return delta.trim().length > 0 ? delta : "";
		} catch {
			return "";
		}
	};
	const loadCursor = (cursorFile: string): { value: number } => {
		try {
			const raw = readFileSync(cursorFile, "utf8").trim();
			const n = Number(raw);
			return { value: Number.isFinite(n) && n >= 0 ? n : 0 };
		} catch {
			return { value: 0 };
		}
	};
	const inboxCursorFile = path.join(mailboxDir, "inbox.cursor");
	const outboxCursorFile = path.join(mailboxDir, "outbox.cursor");
	// The first instruction tells the member to read the inbox directly, so
	// content already in the file at supervisor start is consumed by that read;
	// seeding the cursor to the current length keeps the drain loop from
	// re-injecting the same bytes as NEW MAIL (fresh spawn and respawn alike —
	// only mail appended after start arrives as a delta).
	const seedInboxCursor = (): { value: number } => {
		try {
			const length = readFileSync(inboxFile, "utf8").length;
			writeFileSync(inboxCursorFile, String(length), "utf8");
			return { value: length };
		} catch {
			return { value: 0 };
		}
	};
	const inboxCursorRef = seedInboxCursor();
	const outboxCursorRef = loadCursor(outboxCursorFile);
	// Outbox writes drained before the member's first mail delivery are the
	// bootstrap handshake ("ready"), not work products.
	let sawMail = false;

	const drainOutbox = (): void => {
		const delta = readDelta(outboxFile, outboxCursorRef, outboxCursorFile);
		if (delta) {
			appendLog(`report from ${spec.name}:\n${delta}`);
			onReport(delta, !sawMail);
		}
	};

	const armLatch = (): void => {
		settleLatch = new Promise<void>((r) => {
			settleResolve = r;
		});
	};
	const sendPrompt = async (text: string): Promise<Record<string, unknown>> => {
		armLatch();
		return Promise.race([
			child.prompt(text),
			child.exited.then(() => {
				throw new Error("member engine exited before responding");
			}),
		]);
	};

	const waitSettled = async (): Promise<"settled" | "exited"> => {
		// A slow member turn is not engine death: when the 600s window expires we
		// log and re-enter the wait. Only "exited" (child gone or stop requested)
		// escapes as failure — the former boolean conflated timeout with exit and
		// marked live members failed.
		for (;;) {
			const start = Date.now();
			while (!stopped && Date.now() - start < 600_000) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const wake = await Promise.race([
					settleLatch.then(() => "settled" as const),
					child.exited.then(() => "exited" as const),
					new Promise<null>((resolve) => {
						timer = setTimeout(() => resolve(null), POLL_MS);
					}),
				]);
				if (timer) clearTimeout(timer);
				drainOutbox();
				if (wake === "settled") return "settled";
				if (wake === "exited") return "exited";
			}
			if (stopped) return "exited";
			appendLog("member still working after 600s — continuing to wait");
		}
	};

	void (async () => {
		try {
			let initial: Record<string, unknown> = {};
			try {
				initial = await Promise.race([
					child.getState(),
					child.exited.then(() => {
						throw new Error("member engine exited before state");
					}),
				]);
			} catch {
				// dead on arrival — the fallback loop below handles it
			}
			const initialSessionId = sessionIdFromState(initial);
			if (initialSessionId) sessionId = initialSessionId;
			onState({ status: "working", sessionId });

			const role = await rolePromptFor(spec, teamId, objective);
			const firstInstruction = `${role}\n\nFIRST INSTRUCTION: Read your inbox. If empty, append "ready" to your outbox and await instructions.`;
			let alive = false;
			try {
				await sendPrompt(firstInstruction);
				alive = (await waitSettled()) === "settled";
			} catch (error) {
				appendLog(`bootstrap failed: ${String(error).slice(0, 160)}`);
			}
			// No JSON-mode fallback here (unlike roster's one-shot delegations):
			// a member is a long-lived RPC child whose supervisor drives persistent
			// getState/prompt cycles plus mailbox polling; JSON mode is turn-based
			// and one-shot, so it cannot host that loop — a dead member is revived
			// wholesale by team_respawn instead.
			while (!alive && !stopped) {
				if (tally.turns !== turnsAtSpawn) {
					appendLog(
						`member engine died mid-work after ${tally.turns - turnsAtSpawn} turns — not retrying`,
					);
					break;
				}
				if (modelIndex >= modelCandidates.length - 1) break;
				modelIndex += 1;
				const nextModel = modelCandidates[modelIndex];
				const prevModel = modelCandidates[modelIndex - 1] ?? "engine";
				if (!nextModel) break;
				appendLog(`! ${prevModel} produced no work — falling back to ${nextModel}`);
				turnsAtSpawn = tally.turns;
				child.kill();
				child = createChild(nextModel);
				try {
					const state = await Promise.race([
						child.getState(),
						child.exited.then(() => {
							throw new Error("fallback engine exited before state");
						}),
					]);
					const sid = sessionIdFromState(state);
					if (sid) sessionId = sid;
					await sendPrompt(firstInstruction);
					alive = (await waitSettled()) === "settled";
				} catch (error) {
					appendLog(`fallback bootstrap failed: ${String(error).slice(0, 160)}`);
				}
			}
			if (!alive) stopped = true;
			drainOutbox();

			while (!stopped) {
				const mail = readDelta(inboxFile, inboxCursorRef, inboxCursorFile);
				if (mail) {
					// Set before the mail run: reports drained mid-turn (waitSettled
					// polls) must already count as work, not handshake.
					sawMail = true;
					onState({ status: "working", sessionId });
					let settledRun = false;
					try {
						await sendPrompt(`NEW MAIL:\n${mail}\n\nAct on it, report to your outbox.`);
						settledRun = (await waitSettled()) === "settled";
					} catch (error) {
						appendLog(`member run failed: ${String(error).slice(0, 160)}`);
					}
					if (!settledRun && !stopped) {
						appendLog(
							`member engine exited during mail run (turns this child: ${tally.turns - turnsAtSpawn})`,
						);
						break;
					}
					drainOutbox();
					continue;
				}
				onState({ status: "idle", sessionId });
				await sleep(POLL_MS);
				drainOutbox();
			}
		} catch (error) {
			appendLog(
				`supervisor error: ${String(error)} | engineBin=${engineBin} | stderr=${child.stderrText.slice(0, 300)}`,
			);
		} finally {
			stopped = true;
			void child.exited.then(
				(code) => resolveExited(typeof code === "number" ? code : 1),
				() => resolveExited(1),
			);
			onState({ status: "stopped", sessionId });
			appendLog("member stopped");
		}
	})();

	return {
		stop: () => {
			stopped = true;
			child.kill();
		},
		forceKill: () => {
			child.kill("SIGKILL");
		},
		mailboxDir,
		exited: exitedAll,
	};
}
