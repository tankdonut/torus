import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCost } from "../fsutil.js";
import { osNotify } from "../osnotify.js";
import { DEFAULT_MEMBER_MODEL } from "../providers/index.js";
import {
	AGENT_NAME_RE,
	attachControl,
	attachSessionId,
	dropTeam,
	emitTorusCustom,
	finishDelegation,
	getTeam,
	listDelegations,
	listExternalRuns,
	listTeams,
	publishExternalRun,
	registerTeam as registerTeamRecord,
	sharedState,
	startDelegation,
	type TeamRecord,
	updateDelegation,
	updateExternalRun,
} from "../registry.js";
import { AGENTS, type DelegationOutcome, runDelegation } from "../roster/index.js";
import {
	deliverMail,
	listTeamIds,
	type MemberHandle,
	markTeamStatus,
	readTasksFile,
	readTeamSpec,
	spawnMember,
	tasksFile,
	teamDir,
	updateTasksFile,
	writeTeamSpec,
} from "../team-runtime.js";

const DELEGATABLE = AGENTS.filter((a) => a.mode !== "session");
const AGENT_NAMES = DELEGATABLE.map((a) => a.name).join(", ");

const MAX_PARALLEL = 8;
const CHAIN_CONTEXT_LIMIT = 4000;

/** Fan-out result coalescing window (see flushBatch); module-level for test overriding. */
let fanoutCoalesceMs = 5_000;

/** Test seam: shrink the window to force staggered single-run flushes in tests. */
export function setFanoutCoalesceForTesting(ms: number): void {
	fanoutCoalesceMs = ms;
}

const fanoutTool = defineTool({
	name: "torus_fanout",
	label: "Torus Fan-out",
	description:
		"Run multiple independent torus agent delegations in parallel. Use for independent subtasks (searches, reviews, per-file work). Every run gets its own session, pane, and fleet entry.",
	parameters: Type.Object({
		runs: Type.Array(
			Type.Object({
				agent: Type.String({ description: `Agent name: ${AGENT_NAMES}` }),
				task: Type.String({ description: "Self-contained task text" }),
				handle: Type.Optional(
					Type.String({
						description:
							"Short @handle nickname for this run (fleet views, tmux pane title, statusline)",
					}),
				),
				skills: Type.Optional(
					Type.Array(
						Type.String({ description: "Skill names or paths passed to this run's subagent" }),
						{ maxItems: 8 },
					),
				),
				cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
				model: Type.Optional(
					Type.String({
						description:
							"Model for this run: 'primary' or 'fast' (chain shorthands) or an exact id like zai/glm-5.3",
					}),
				),
			}),
			{ minItems: 2, maxItems: MAX_PARALLEL },
		),
	}),
	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		const started = Date.now();
		const report = () => {
			if (!onUpdate) return;
			const line = params.runs
				.map((r) => `${r.handle ? `@${r.handle.replace(/^@+/, "")}` : r.agent}:running`)
				.join(" · ");
			onUpdate({ content: [{ type: "text", text: line }], details: { phase: "running" } });
		};
		report();

		const parentSession = ctx.sessionManager.getSessionId();
		// One combined start marker: N per-run torus.delegation-start events
		// would trickle into the transcript one turn boundary apart.
		emitTorusCustom(
			{
				customType: "torus.delegation-start",
				content: [
					{
						type: "text",
						text: `fan-out ×${params.runs.length}: ${params.runs
							.map((r) => {
								const handle = r.handle?.trim().replace(/^@+/, "") ?? null;
								return handle ? `@${handle} (${r.agent})` : r.agent;
							})
							.join(", ")}`,
					},
				],
				display: true,
				details: { agent: "fan-out", runs: params.runs.length },
			},
			{ triggerTurn: false },
		);
		// Result-marker coalescer: completions landing within COALESCE_MS merge
		// into one combined torus.delegation-result (per-run markers would trickle
		// into the transcript one turn boundary apart); the whole batch finishing
		// flushes early instead of waiting out the window.
		const COALESCE_MS = fanoutCoalesceMs;
		type FanoutEntry = {
			label: string;
			/** Bare handle (no "@") for the result marker; null for handleless runs. */
			handle: string | null;
			agent: string;
			ok: boolean;
			delegationId: string | null;
			turns: number;
			/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
			cost: number;
			durationMs: number;
		};
		let batch: FanoutEntry[] = [];
		let flushTimer: ReturnType<typeof setTimeout> | null = null;
		const flushBatch = (): void => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			if (batch.length === 0) return;
			const entries = batch;
			batch = [];
			const single = entries.length === 1 ? entries[0] : undefined;
			// One filtered list feeds both arrays: a run without a delegation id
			// contributes neither an id nor a cost entry, so costs stay
			// index-aligned with delegationIds in mixed success/failure batches.
			const identified = entries.filter(
				(e): e is FanoutEntry & { delegationId: string } => typeof e.delegationId === "string",
			);
			emitTorusCustom(
				{
					customType: "torus.delegation-result",
					content: [
						{
							type: "text",
							text: `fan-out ${entries.map((e) => `${e.label} ${e.ok ? "✓" : "✗"}`).join(", ")}`,
						},
					],
					display: true,
					details: {
						// Bare handle: the notify renderer prepends "@"; combined batches
						// have no single handle and fall back to agent "fan-out".
						agent: single ? single.agent : "fan-out",
						handle: single?.handle ?? undefined,
						ok: entries.every((e) => e.ok),
						delegationId: single?.delegationId ?? undefined,
						delegationIds: identified.map((e) => e.delegationId),
						runs: entries.length,
						turns: entries.reduce((sum, e) => sum + e.turns, 0),
						// Per-run costs in completion order (aligned with delegationIds)
						// plus the summed batch cost; 0 when a model has no catalog price.
						costs: identified.map((e) => e.cost),
						cost: entries.reduce((sum, e) => sum + e.cost, 0),
						durationMs: Math.max(...entries.map((e) => e.durationMs)),
					},
				},
				{ triggerTurn: false },
			);
		};
		const coalesce = (entry: FanoutEntry): void => {
			batch.push(entry);
			if (batch.length >= params.runs.length) {
				flushBatch();
				return;
			}
			if (!flushTimer) {
				flushTimer = setTimeout(flushBatch, COALESCE_MS);
				flushTimer.unref();
			}
		};
		const settledRuns = await Promise.allSettled(
			params.runs.map(async (run) => {
				// Per-run statusline marker, same shape as the delegate tool, so
				// parallel fan-out runs stay visible while they work.
				const handle = run.handle?.trim().replace(/^@+/, "") ?? null;
				const label = handle ? `@${handle}` : run.agent;
				// Id-suffixed from the first snapshot so handleless same-agent runs in
				// one fan-out never share (or early-clear) one statusline entry.
				const baseStatusKey = `torus:${handle ?? run.agent}`;
				let statusKey = baseStatusKey;
				ctx.ui.setStatus(statusKey, `▶ ${label} · starting`);
				const runStartedAt = Date.now();
				try {
					const outcome = await runDelegation(
						run.agent,
						run.task,
						run.cwd,
						(snapshot) => {
							if (snapshot.delegationId) {
								const keyed = `${baseStatusKey}:${snapshot.delegationId.slice(0, 8)}`;
								if (keyed !== statusKey) {
									ctx.ui.setStatus(statusKey, undefined);
									statusKey = keyed;
								}
							}
							ctx.ui.setStatus(
								statusKey,
								`▶ ${label} · turn ${snapshot.turns} · ${snapshot.usage.output} tok`,
							);
						},
						parentSession,
						handle,
						run.skills ?? null,
						false,
						false,
						{ model: run.model ?? null },
					);
					const usage = outcome.details.usage as { turns?: number; cost?: number } | undefined;
					coalesce({
						label,
						handle,
						agent: run.agent,
						ok: outcome.ok,
						delegationId: outcome.delegationId,
						turns: usage?.turns ?? 0,
						cost: typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : 0,
						durationMs: Date.now() - runStartedAt,
					});
					return {
						agent: run.agent,
						ok: outcome.ok,
						text: outcome.text,
						details: outcome.details,
					};
				} catch (error) {
					coalesce({
						label,
						handle,
						agent: run.agent,
						ok: false,
						delegationId: null,
						turns: 0,
						cost: 0,
						durationMs: Date.now() - runStartedAt,
					});
					throw error;
				} finally {
					ctx.ui.setStatus(statusKey, undefined);
				}
			}),
		);
		const outcomes = settledRuns.map((s, i) => {
			if (s.status === "fulfilled") return s.value;
			const run = params.runs[i];
			return { agent: run?.agent ?? "unknown", ok: false, text: String(s.reason) };
		});

		const summary = outcomes
			.map((o) => `## ${o.agent} — ${o.ok ? "done" : "failed"}\n${o.text.slice(0, 2000)}`)
			.join("\n\n");
		return {
			content: [
				{
					type: "text",
					text: `fan-out complete in ${Math.round((Date.now() - started) / 1000)}s\n\n${summary}`,
				},
			],
			details: { runs: outcomes.length, ok: outcomes.filter((o) => o.ok).length },
		};
	},
});

const chainTool = defineTool({
	name: "torus_chain",
	label: "Torus Chain",
	description:
		"Run torus agent delegations sequentially, feeding each step the previous step's output as context. Use for pipeline work (research -> plan -> build -> review).",
	parameters: Type.Object({
		steps: Type.Array(
			Type.Object({
				agent: Type.String({ description: `Agent name: ${AGENT_NAMES}` }),
				task: Type.String({
					description: "Step task; the prior step's output is appended automatically",
				}),
				handle: Type.Optional(
					Type.String({
						description:
							"Short @handle nickname for this step (fleet views, tmux pane title, statusline)",
					}),
				),
				skills: Type.Optional(
					Type.Array(
						Type.String({ description: "Skill names or paths passed to this step's subagent" }),
						{ maxItems: 8 },
					),
				),
				cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
				model: Type.Optional(
					Type.String({
						description:
							"Model for this step: 'primary' or 'fast' (chain shorthands) or an exact id like zai/glm-5.3",
					}),
				),
			}),
			{ minItems: 2, maxItems: 6 },
		),
	}),
	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		const started = Date.now();
		const parentSession = ctx.sessionManager.getSessionId();
		const outcomes: Array<{ agent: string; ok: boolean; text: string }> = [];
		let carry = "";

		for (let i = 0; i < params.steps.length; i += 1) {
			const step = params.steps[i];
			if (!step) continue;
			const context =
				carry.length > 0
					? `${step.task}\n\n--- Previous step output (${outcomes[i - 1]?.agent ?? "prior"}):\n${carry.slice(0, CHAIN_CONTEXT_LIMIT)}`
					: step.task;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `step ${i + 1}/${params.steps.length}: ${step.handle ? `@${step.handle.replace(/^@+/, "")}` : step.agent} running`,
					},
				],
				details: { phase: "running", step: i + 1 },
			});
			const handle = step.handle?.trim().replace(/^@+/, "") ?? null;
			const label = handle ? `@${handle}` : step.agent;
			// Id-suffixed from the first snapshot so handleless same-agent steps
			// never share (or early-clear) one statusline entry.
			const baseStatusKey = `torus:${handle ?? step.agent}`;
			let statusKey = baseStatusKey;
			ctx.ui.setStatus(statusKey, `▶ ${label} · starting`);
			let outcome: DelegationOutcome;
			try {
				outcome = await runDelegation(
					step.agent,
					context,
					step.cwd,
					(snapshot) => {
						if (snapshot.delegationId) {
							const keyed = `${baseStatusKey}:${snapshot.delegationId.slice(0, 8)}`;
							if (keyed !== statusKey) {
								ctx.ui.setStatus(statusKey, undefined);
								statusKey = keyed;
							}
						}
						ctx.ui.setStatus(
							statusKey,
							`▶ ${label} · turn ${snapshot.turns} · ${snapshot.usage.output} tok`,
						);
					},
					parentSession,
					handle,
					step.skills ?? null,
					undefined,
					undefined,
					{ model: step.model ?? null },
				);
			} finally {
				ctx.ui.setStatus(statusKey, undefined);
			}
			outcomes.push({ agent: step.agent, ok: outcome.ok, text: outcome.text });
			if (!outcome.ok) break;
			carry = outcome.text;
		}

		const summary = outcomes
			.map((o) => `## ${o.agent} — ${o.ok ? "done" : "failed"}\n${o.text.slice(0, 2000)}`)
			.join("\n\n");
		return {
			content: [
				{
					type: "text",
					text: `chain complete in ${Math.round((Date.now() - started) / 1000)}s\n\n${summary}`,
				},
			],
			details: { steps: outcomes.length, ok: outcomes.filter((o) => o.ok).length },
		};
	},
});

const memberControls = sharedState(
	Symbol.for("torus.team-controls.v1"),
	() => new Map<string, MemberHandle>(),
);

/** Members marked for deliberate shutdown (team_delete / fleet stop); other stops surface as failures. */
const deliberateStops = sharedState(
	Symbol.for("torus.member-deliberate-stops.v1"),
	() => new Set<string>(),
);

/** Supervisor generation per member id: a respawn invalidates the prior closure's registry writes. */
const memberGenerations = sharedState(
	Symbol.for("torus.member-generations.v1"),
	() => new Map<string, number>(),
);

/**
 * Per-member wake-up state: teams are pull-based, so nothing pushes member
 * reports into the parent session. A member that goes idle (or stops
 * non-deliberately) while holding an unread report queues one wake episode.
 * The news latch re-arms on the next report; bootstrap "ready" handshakes
 * never arm it (team-runtime passes the phase).
 */
const memberHasNews = sharedState(
	Symbol.for("torus.member-has-news.v1"),
	() => new Map<string, boolean>(),
);

/**
 * Wake coalescing: episodes collect per team and flush as ONE combined
 * torus.team-wake marker after a short window. N members finishing within
 * minutes would otherwise queue N triggerTurn follow-ups that drain one turn
 * boundary apart — each a wasted model turn, all stale by the time they land
 * (same rationale as team_create's combined delegation-start marker).
 */
const TEAM_WAKE_COALESCE_MS = 10_000;
const pendingTeamWakes = sharedState(
	Symbol.for("torus.team-wake-pending.v1"),
	() => new Map<string, Set<string>>(),
);
const pendingWakeTimers = sharedState(
	Symbol.for("torus.team-wake-timers.v1"),
	() => new Map<string, ReturnType<typeof setTimeout>>(),
);

function notifyMemberEpisode(teamId: string, memberId: string): void {
	if (process.env["TORUS_TEAM_NOTIFY"] === "0") return;
	const record = getTeam(teamId);
	const member = record?.members.find((m) => m.id === memberId);
	if (!record || !member || record.status !== "active") return;
	if (member.status !== "idle" && member.status !== "stopped") return;
	if (!memberHasNews.get(memberId)) return;
	let pending = pendingTeamWakes.get(teamId);
	if (!pending) {
		pending = new Set();
		pendingTeamWakes.set(teamId, pending);
	}
	pending.add(memberId);
	if (!pendingWakeTimers.has(teamId)) {
		const timer = setTimeout(() => {
			pendingWakeTimers.delete(teamId);
			flushTeamWake(teamId);
		}, TEAM_WAKE_COALESCE_MS);
		timer.unref();
		pendingWakeTimers.set(teamId, timer);
	}
}

/** Newest outbox content: outboxes are append-only, so the file tail is the
 * freshest entry regardless of the heading format each member writes. */
function outboxTail(member: { mailboxDir: string }): string {
	try {
		const outbox = readFileSync(path.join(member.mailboxDir, "outbox.md"), "utf8");
		const squashed = outbox.replace(/\s+/g, " ").trim();
		return squashed.length > 200 ? squashed.slice(-200) : squashed;
	} catch {
		// no outbox yet — the status line alone still carries the signal
		return "";
	}
}

function flushTeamWake(teamId: string): void {
	const pending = pendingTeamWakes.get(teamId);
	pendingTeamWakes.delete(teamId);
	const timer = pendingWakeTimers.get(teamId);
	if (timer) {
		clearTimeout(timer);
		pendingWakeTimers.delete(teamId);
	}
	if (!pending || pending.size === 0) return;
	const record = getTeam(teamId);
	if (record?.status !== "active") return;
	const episodes: { member: string; agent: string; status: string; reason: string }[] = [];
	for (const memberId of pending) {
		const member = record.members.find((m) => m.id === memberId);
		// A member back to working (respawn, new task) defers to its next idle
		// episode: leave the latch armed and drop this stale queue entry.
		if (!member || (member.status !== "idle" && member.status !== "stopped")) continue;
		if (!memberHasNews.get(memberId)) continue;
		memberHasNews.delete(memberId);
		const tail = outboxTail(member);
		episodes.push({
			member: member.name,
			agent: member.agent,
			status: member.status,
			reason:
				tail.length > 0
					? `report: ${tail}`
					: member.status === "stopped"
						? "stopped unexpectedly (no report read)"
						: "new report waiting",
		});
	}
	if (episodes.length === 0) return;
	const lines = episodes.map((e) => `@${e.member} (${e.agent}) is ${e.status} — ${e.reason}`);
	const first = episodes[0];
	const text =
		episodes.length === 1
			? `[torus] team ${record.name}: ${lines[0]}. Run team_status for the latest outbox reports, team_msg to assign more work, or team_delete to shut down.`
			: `[torus] team ${record.name}: ${episodes.length} members finished — ${lines.join("; ")}. Run team_status for the latest outbox reports, team_msg to assign more work, or team_delete to shut down.`;
	// Wake via a triggerTurn marker (the monitor pattern), never a bare user
	// follow-up: a queued follow-up is only consumed by a run, so an
	// interrupted turn strands it pending until the next user input.
	// triggerTurn forces a run when the session is idle, and that run also
	// drains any follow-ups orphaned before it (verified against pi 1.0.2).
	const delivered = emitTorusCustom(
		{
			customType: "torus.team-wake",
			content: [{ type: "text", text }],
			display: true,
			details: {
				team: record.name,
				members: episodes,
				...(episodes.length === 1 && first
					? { member: first.member, agent: first.agent, status: first.status, reason: first.reason }
					: {}),
			},
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	if (!delivered) {
		try {
			appendFileSync(
				path.join(teamDir(teamId), "team.log"),
				`[${new Date().toISOString()}] wake-up for ${episodes.map((e) => `@${e.member}`).join(", ")} not delivered (no session sender)\n`,
				"utf8",
			);
		} catch {
			// team dir gone — best-effort log
		}
	}
}

export type MemberSpawner = typeof spawnMember;
const spawnerState = sharedState(Symbol.for("torus.member-spawner.v1"), () => ({
	spawn: spawnMember as MemberSpawner,
}));

/** Test-only: substitute the member spawner (null restores the real engine spawner). */
export function setMemberSpawnerForTesting(spawn: MemberSpawner | null): void {
	spawnerState.spawn = spawn ?? spawnMember;
}

/** Test-only: flush every pending team wake-up immediately. */
export function flushTeamWakesForTesting(): void {
	for (const teamId of [...pendingTeamWakes.keys()]) flushTeamWake(teamId);
}

/**
 * Finish a member's delegation record and emit its torus.delegation-result
 * marker. Idempotent on record status, so team_delete's safety pass and the
 * supervisor's stopped callback cannot double-finish; a failed registry write
 * still lets the marker through.
 */
/** Members whose per-member result marker is suppressed because a batch caller (team_delete) emits one combined marker. */
const suppressedResultMarkers = sharedState(
	Symbol.for("torus.team-result-markers-suppressed.v1"),
	() => new Set<string>(),
);

function finishMemberDelegation(
	teamId: string,
	memberId: string,
	ok: boolean,
	finalText: string,
	sessionId: string | null,
): void {
	const existing = listDelegations().find((r) => r.id === memberId);
	if (existing?.status !== "running") return;
	const durationMs = Date.now() - existing.startedAt;
	const suppressed = suppressedResultMarkers.has(memberId);
	try {
		finishDelegation(memberId, ok, finalText, sessionId, { toast: !suppressed });
	} catch {
		// registry finish failed (e.g. unwritable log); the marker below still goes out
	}
	if (suppressed) return;
	emitTorusCustom({
		customType: "torus.delegation-result",
		content: [
			{
				type: "text",
				text: `${existing.handle ?? existing.agent} ${ok ? "stopped" : "failed"}`,
			},
		],
		display: true,
		details: {
			agent: existing.agent,
			ok,
			delegationId: memberId,
			handle: existing.handle,
			team: teamId,
			teamName: getTeam(teamId)?.name ?? teamId,
			sessionId,
			durationMs,
		},
	});
}

/**
 * Spawn a member with the full create-tool callback semantics: state changes
 * update the team record and publish the session id, reports land in team.log,
 * and stats flow to the fleet run entry. The member is also onboarded into the
 * delegation registry (log file, run beacon, fleet-view stop/steer) and its
 * lifecycle is mirrored into the transcript via torus.delegation-start/result.
 * Any prior control for the member id is stopped and replaced (respawn path).
 */
function attachMember(
	teamId: string,
	memberId: string,
	spec: { name: string; agent: string; model?: string },
	objective: string,
	onStats?: boolean,
	parentSession: string | null = null,
): MemberHandle {
	const generation = (memberGenerations.get(memberId) ?? 0) + 1;
	memberGenerations.set(memberId, generation);
	const isCurrentGeneration = () => memberGenerations.get(memberId) === generation;
	deliberateStops.delete(memberId);
	memberHasNews.delete(memberId);
	startDelegation(
		memberId,
		spec.agent,
		spec.model ?? DEFAULT_MEMBER_MODEL,
		parentSession,
		spec.name,
	);
	// Publish only after the registry record exists: a startDelegation throw
	// must not strand a phantom running external run in the fleet.
	publishExternalRun({
		id: memberId,
		source: `torus-team:${teamId}`,
		label: spec.name,
		handle: spec.name,
		model: spec.model ?? DEFAULT_MEMBER_MODEL,
		logFile: path.join(teamDir(teamId), `${spec.name}.log`),
		state: "running",
	});
	// Callers spawning a batch (team_create, team_respawn) emit one combined
	// torus.delegation-start marker themselves: N per-member events would
	// trickle into the transcript one turn boundary apart.
	let lastReport = "";
	let handle: MemberHandle;
	try {
		handle = spawnerState.spawn(
			teamId,
			spec,
			objective,
			(state) => {
				const entry = getTeam(teamId)?.members.find((m) => m.id === memberId);
				if (entry) {
					entry.status = state.status;
					entry.sessionId = state.sessionId;
				}
				if (!isCurrentGeneration()) return;
				if (state.status === "working" || state.status === "starting") {
					const run = listExternalRuns().find((r) => r.id === memberId);
					const patch: { memberStatus: "working"; activeUpdatedAt?: number } = {
						memberStatus: "working",
					};
					// Keep the accumulation base across back-to-back working spells;
					// idle banks the elapsed time before freezing it.
					if (run?.memberStatus !== "working") patch.activeUpdatedAt = Date.now();
					updateExternalRun(memberId, patch);
				}
				if (state.sessionId) {
					updateExternalRun(memberId, { sessionId: state.sessionId });
					attachSessionId(memberId, state.sessionId);
				}
				if (state.status === "idle") {
					const run = listExternalRuns().find((r) => r.id === memberId);
					const banked =
						(run?.activeSeconds ?? 0) +
						(run?.activeUpdatedAt ? Date.now() - run.activeUpdatedAt : 0);
					updateExternalRun(memberId, {
						memberStatus: "idle",
						activeSeconds: Math.max(0, banked),
						activeUpdatedAt: Date.now(),
					});
					notifyMemberEpisode(teamId, memberId);
				}
				if (state.status === "stopped") {
					updateExternalRun(memberId, { state: "done", memberStatus: "stopped" });
					const deliberate = deliberateStops.delete(memberId);
					if (!deliberate) memberHasNews.set(memberId, true);
					const summary =
						lastReport.trim().length > 0
							? lastReport.trim().slice(0, 2000)
							: `member stopped ${deliberate ? "(team shutdown)" : "(unexpected exit)"}`;
					finishMemberDelegation(teamId, memberId, deliberate, summary, state.sessionId);
					notifyMemberEpisode(teamId, memberId);
				}
			},
			(report, handshake) => {
				lastReport = report;
				try {
					appendFileSync(
						path.join(teamDir(teamId), "team.log"),
						`[${new Date().toISOString()}] ${spec.name} reports:\n${report}\n`,
						"utf8",
					);
				} catch {
					// team dir gone — best-effort log
				}
				// The bootstrap "ready" write is a handshake, not a report: the
				// settled spawn turn already proved liveness, so it must not arm
				// the per-member wake-up latch.
				if (handshake) return;
				memberHasNews.set(memberId, true);
				notifyMemberEpisode(teamId, memberId);
			},
			onStats === true
				? (stats) => {
						if (!isCurrentGeneration()) return;
						updateExternalRun(memberId, stats);
						updateDelegation(memberId, {
							text: stats.text,
							turns: stats.turns,
							usage: {
								input: stats.tokensIn,
								output: stats.tokensOut,
								cacheRead: stats.cacheRead,
								cacheWrite: stats.cacheWrite,
								cost: stats.cost,
							},
						});
					}
				: undefined,
		);
	} catch (error) {
		finishMemberDelegation(
			teamId,
			memberId,
			false,
			`member spawn failed: ${String(error).slice(0, 200)}`,
			null,
		);
		throw error;
	}
	memberControls.get(memberId)?.stop();
	memberControls.set(memberId, handle);
	// Bridge the registry control surface onto the member so the fleet overlay's
	// stop (x) and steer act on it like any delegation; torus.team-controls.v1
	// stays the in-module source of truth for team_delete/respawn.
	attachControl(memberId, {
		stop: () => {
			deliberateStops.add(memberId);
			memberControls.get(memberId)?.stop();
		},
		steer: (text) => {
			if (!memberControls.has(memberId)) return false;
			deliverMail(teamId, spec.name, "lead", text);
			return true;
		},
	});
	return handle;
}

function resolveTeam(id?: string): TeamRecord | undefined {
	return id
		? getTeam(id)
		: listTeams().find(
				(t) => t.status === "active" && t.members.some((m) => m.status !== "stopped"),
			);
}

function teamRosterText(record: {
	name: string;
	objective: string;
	status: string;
	members: Array<{ name: string; agent: string; status: string; sessionId: string | null }>;
}): string {
	const members = record.members
		.map(
			(m) =>
				`- ${m.name} (${m.agent}) ${m.status}${m.sessionId ? ` · session ${m.sessionId.slice(0, 8)}` : ""}`,
		)
		.join("\n");
	return `team ${record.name} [${record.status}] — ${record.objective}\n${members}`;
}

const teamCreateTool = defineTool({
	name: "team_create",
	label: "Torus Team Create",
	description:
		"Create a persistent team: spawns long-lived member agents (RPC children with mailboxes and a shared tasklist). Members act on their role until shutdown.",
	parameters: Type.Object({
		name: Type.String({ description: "Short team name (slug)" }),
		objective: Type.String({ description: "The team's standing objective, given to every member" }),
		members: Type.Array(
			Type.Object({
				name: Type.String({ description: "Member handle (unique in team)" }),
				agent: Type.String({ description: "Role prompt: agent name from the roster" }),
				model: Type.Optional(
					Type.String({ description: "Override model (default glm-5.3-flash)" }),
				),
				cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			}),
			{ minItems: 1, maxItems: 8 },
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const invalidMember = params.members.find((member) => !AGENT_NAME_RE.test(member.name));
		if (invalidMember) {
			return {
				content: [
					{
						type: "text",
						text: `invalid member name "${invalidMember.name}" — must match ${AGENT_NAME_RE}`,
					},
				],
				details: {
					teamId: undefined as string | undefined,
					members: undefined as number | undefined,
				},
				isError: true,
			};
		}
		const names = params.members.map((member) => member.name);
		const duplicate = names.find((name, index) => names.indexOf(name) !== index);
		if (duplicate) {
			return {
				content: [
					{
						type: "text",
						text: `duplicate member name "${duplicate}" — each member needs a unique handle (mailboxes are keyed by name)`,
					},
				],
				details: {
					teamId: undefined as string | undefined,
					members: undefined as number | undefined,
				},
				isError: true,
			};
		}
		const teamId = `${params.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${Date.now().toString(36)}`;
		const record: TeamRecord = {
			id: teamId,
			name: params.name,
			objective: params.objective,
			status: "active" as const,
			dir: teamDir(teamId),
			members: [],
			createdAt: Date.now(),
		};
		registerTeamRecord(record);
		const parentSession = ctx?.sessionManager?.getSessionId?.() ?? null;
		writeTeamSpec(teamId, {
			name: params.name,
			objective: params.objective,
			members: params.members,
			parentSession,
		});
		for (const spec of params.members) {
			const memberId = `${teamId}/${spec.name}`;
			const memberRecord = {
				id: memberId,
				name: spec.name,
				agent: spec.agent,
				model: spec.model ?? DEFAULT_MEMBER_MODEL,
				status: "starting" as const,
				sessionId: null as string | null,
				startedAt: Date.now(),
				mailboxDir: "",
			};
			record.members.push(memberRecord);
			const handle = attachMember(teamId, memberId, spec, params.objective, true, parentSession);
			memberRecord.mailboxDir = handle.mailboxDir;
		}
		emitTorusCustom(
			{
				customType: "torus.delegation-start",
				content: [
					{
						type: "text",
						text: `@${params.members.map((m) => `${m.name} (${m.agent})`).join(", @")} spawned`,
					},
				],
				display: true,
				details: {
					agent: "team",
					handle: params.name,
					team: teamId,
					teamName: params.name,
					members: params.members.map((m) => m.name),
				},
			},
			{ triggerTurn: false },
		);
		return {
			content: [
				{
					type: "text",
					text: `team ${teamId} created with ${record.members.length} member(s).\n${teamRosterText(record)}\nmailboxes: ${path.join(teamDir(teamId), "mailboxes")}\ntasklist: ${tasksFile(teamId)}\nTools: team_msg, team_task_create/list/update, team_status, team_delete.`,
				},
			],
			details: { teamId, members: record.members.length },
		};
	},
});

const teamStatusTool = defineTool({
	name: "team_status",
	label: "Torus Team Status",
	description: "Roster, member states, and the latest outbox report per member",
	parameters: Type.Object({
		team: Type.Optional(Type.String({ description: "Team id (default: most recent active team)" })),
	}),
	async execute(_toolCallId, params) {
		const record = resolveTeam(params.team);
		if (!record)
			return {
				content: [{ type: "text", text: "No such team. Create one with team_create." }],
				isError: true,
				details: { teamId: undefined as string | undefined },
			};
		const reports = record.members.map((m) => {
			let tail = "(no report yet)";
			try {
				const outbox = readFileSync(path.join(m.mailboxDir, "outbox.md"), "utf8");
				const blocks = outbox.split(/\n(?=\[)/).filter((b) => b.trim().length > 0);
				// biome-ignore lint/style/noNonNullAssertion: guarded by blocks.length > 0 on this line
				if (blocks.length > 0) tail = blocks[blocks.length - 1]!.slice(0, 400);
			} catch {
				tail = "(no outbox yet)";
			}
			const memberRun = listDelegations().find((r) => r.id === `${record.id}/${m.name}`);
			const cost = formatCost(
				memberRun?.cost,
				(memberRun?.tokensIn ?? 0) + (memberRun?.tokensOut ?? 0) > 0,
			);
			return `- ${m.name} (${m.agent}) · ${m.status}${cost ? ` · ${cost}` : ""} — ${tail}`;
		});
		// Durability surfacing: a task left in_progress under a member that has
		// since stopped can never be finished by itself — name it so the lead can
		// reassign or close it. Read-only: no task is mutated here.
		const orphans: string[] = [];
		for (const task of readTasksFile(record.id).tasks) {
			if (task.status !== "in_progress" || task.assignee === null) continue;
			if (!record.members.some((m) => m.name === task.assignee && m.status === "stopped")) continue;
			orphans.push(
				`orphaned: ${task.id} (${task.subject}) was in-progress under @${task.assignee} (stopped) — reassign or complete via team_task_update`,
			);
		}
		return {
			content: [
				{
					type: "text",
					text: `team ${record.name} [${record.status}] — ${record.objective}\n${reports.concat(orphans).join("\n")}`,
				},
			],
			details: { teamId: record.id },
		};
	},
});

const teamMsgTool = defineTool({
	name: "team_msg",
	label: "Torus Team Message",
	description: "Deliver a message to one member (or all with '*') by appending to their inbox file",
	parameters: Type.Object({
		team: Type.String(),
		to: Type.String({ description: "Member name, or * for all members" }),
		text: Type.String(),
	}),
	async execute(_toolCallId, params) {
		const record = getTeam(params.team);
		if (!record || !AGENT_NAME_RE.test(params.team)) {
			return {
				content: [{ type: "text", text: "No such team." }],
				details: { delivered: undefined as number | undefined },
				isError: true,
			};
		}
		const targets =
			params.to === "*" ? record.members : record.members.filter((m) => m.name === params.to);
		for (const member of targets) deliverMail(record.id, member.name, "lead", params.text);
		return {
			content: [{ type: "text", text: `delivered to ${targets.length} mailbox(es)` }],
			details: { delivered: targets.length },
		};
	},
});

const teamTaskCreateTool = defineTool({
	name: "team_task_create",
	label: "Torus Team Task Create",
	description: "Create a task on the team shared tasklist",
	parameters: Type.Object({
		team: Type.String(),
		subject: Type.String(),
		assignee: Type.Optional(Type.String({ description: "Member name (default: unassigned)" })),
	}),
	async execute(_toolCallId, params) {
		const record = getTeam(params.team);
		if (!record || !AGENT_NAME_RE.test(params.team))
			return { content: [{ type: "text", text: "No such team." }], details: {}, isError: true };
		let created = "";
		updateTasksFile(record.id, (file) => {
			const task = {
				id: `t${file.nextId}`,
				subject: params.subject,
				assignee: params.assignee ?? null,
				status: "pending",
				updatedAt: new Date().toISOString(),
			};
			created = `task ${task.id} created${task.assignee ? ` for ${task.assignee}` : ""}`;
			return { tasks: [...file.tasks, task], nextId: file.nextId + 1 };
		});
		return { content: [{ type: "text", text: created }], details: {} };
	},
});

const teamTaskListTool = defineTool({
	name: "team_task_list",
	label: "Torus Team Task List",
	description: "List the team shared tasklist",
	parameters: Type.Object({ team: Type.String() }),
	async execute(_toolCallId, params) {
		const record = getTeam(params.team);
		if (!record || !AGENT_NAME_RE.test(params.team))
			return { content: [{ type: "text", text: "No such team." }], details: {}, isError: true };
		const tasks = readTasksFile(record.id).tasks;
		const text =
			tasks.length === 0
				? "(no tasks)"
				: tasks
						.map(
							(t) => `- ${t.id} [${t.status}] ${t.assignee ? `@${t.assignee} ` : ""}${t.subject}`,
						)
						.join("\n");
		return { content: [{ type: "text", text }], details: {} };
	},
});

const teamTaskUpdateTool = defineTool({
	name: "team_task_update",
	label: "Torus Team Task Update",
	description: "Update a task status/assignee on the team shared tasklist",
	parameters: Type.Object({
		team: Type.String(),
		task: Type.String({ description: "Task id" }),
		status: Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
				Type.Literal("deleted"),
			],
			{ description: "pending | in_progress | completed | deleted" },
		),
		assignee: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params) {
		const record = getTeam(params.team);
		if (!record || !AGENT_NAME_RE.test(params.team))
			return { content: [{ type: "text", text: "No such team." }], details: {}, isError: true };
		let outcome = `no task ${params.task}`;
		updateTasksFile(record.id, (file) => {
			const task = file.tasks.find((t) => t.id === params.task);
			if (!task) return;
			if (params.status === "deleted") {
				outcome = `task ${params.task} deleted`;
				return { tasks: file.tasks.filter((t) => t.id !== params.task), nextId: file.nextId };
			}
			task.status = params.status;
			if (params.assignee) task.assignee = params.assignee;
			task.updatedAt = new Date().toISOString();
			outcome = `task ${params.task} -> ${task.status}`;
		});
		return { content: [{ type: "text", text: outcome }], details: {} };
	},
});

const teamDeleteTool = defineTool({
	name: "team_delete",
	label: "Torus Team Delete",
	description:
		"Shutdown sequence: stop every member supervisor, mark the team shutdown, drop it from the registry",
	parameters: Type.Object({ team: Type.String() }),
	async execute(_toolCallId, params) {
		const record = getTeam(params.team);
		if (!record)
			return {
				content: [{ type: "text", text: "No such team." }],
				details: { delivered: undefined },
				isError: true,
			};
		for (const member of record.members) {
			deliberateStops.add(member.id);
			suppressedResultMarkers.add(member.id);
			const handle = memberControls.get(member.id);
			handle?.stop();
			updateExternalRun(member.id, { state: "done" });
		}
		for (const member of record.members) {
			const handle = memberControls.get(member.id);
			if (!handle) continue;
			const exited = await Promise.race([
				handle.exited.then(() => true),
				new Promise<boolean>((resolve) => {
					setTimeout(() => resolve(false), 2000);
				}),
			]);
			if (!exited) {
				handle.forceKill();
				await handle.exited;
			}
		}
		markTeamStatus(record.id, "shutdown");
		record.status = "shutdown";
		dropTeam(record.id);
		for (const member of record.members) memberHasNews.delete(member.id);
		pendingTeamWakes.delete(record.id);
		const pendingWakeTimer = pendingWakeTimers.get(record.id);
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimers.delete(record.id);
		}
		for (const member of record.members) {
			memberControls.delete(member.id);
			// Safety pass: a member whose supervisor never delivered its stopped
			// state (hung child force-killed above) still gets a finished record.
			finishMemberDelegation(
				record.id,
				member.id,
				true,
				`team ${record.id} shut down`,
				member.sessionId,
			);
		}
		// One combined result marker for the batch — N per-member stops would
		// trickle into the transcript one turn boundary apart (same rationale as
		// team_create's combined start marker).
		emitTorusCustom(
			{
				customType: "torus.delegation-result",
				content: [
					{
						type: "text",
						text: `@${record.members.map((m) => m.name).join(", @")} stopped (team ${record.id} shut down)`,
					},
				],
				display: true,
				details: {
					agent: "team",
					handle: record.name,
					ok: true,
					team: record.id,
					teamName: record.name,
					members: record.members.map((m) => m.name),
				},
			},
			{ triggerTurn: false },
		);
		osNotify({
			summary: `torus team ${record.name} shut down`,
			body: `${record.members.length} member(s) stopped · logs kept at ${record.dir}`,
			urgency: "normal",
			expireMs: 6000,
			transient: true,
		});
		for (const member of record.members) suppressedResultMarkers.delete(member.id);
		return {
			content: [
				{
					type: "text",
					text: `team ${record.id} shut down (${record.members.length} members stopped); logs and mailboxes kept at ${record.dir}`,
				},
			],
			details: {},
		};
	},
});

const teamRespawnTool = defineTool({
	name: "team_respawn",
	label: "Torus Team Respawn",
	description:
		"Revive stopped members of a team from its persisted spec (after a parent restart). Mailboxes and tasklist are preserved.",
	parameters: Type.Object({
		team: Type.String({ description: "Team id" }),
	}),
	async execute(_toolCallId, params) {
		if (!AGENT_NAME_RE.test(params.team) || !listTeamIds().includes(params.team)) {
			return {
				content: [{ type: "text", text: "No such team (no team.json on disk)." }],
				details: {},
				isError: true,
			};
		}
		const record = getTeam(params.team) ?? rehydrateTeam(params.team);
		if (!record)
			return {
				content: [{ type: "text", text: "No such team (no team.json on disk)." }],
				details: {},
				isError: true,
			};
		const spec = readTeamSpec(record.id);
		if (!spec)
			return {
				content: [{ type: "text", text: "Team spec missing; cannot respawn." }],
				isError: true,
				details: {},
			};
		let revived = 0;
		const revivedNames: string[] = [];
		for (const member of spec.members) {
			const memberId = `${record.id}/${member.name}`;
			const existing = record.members.find((m) => m.id === memberId);
			if (existing && existing.status !== "stopped" && memberControls.has(memberId)) continue;
			const handle = attachMember(
				record.id,
				memberId,
				member,
				spec.objective,
				true,
				spec.parentSession ?? null,
			);
			if (existing) {
				existing.status = "starting";
				existing.startedAt = Date.now();
			} else {
				record.members.push({
					id: memberId,
					name: member.name,
					agent: member.agent,
					model: member.model ?? DEFAULT_MEMBER_MODEL,
					status: "starting",
					sessionId: null,
					startedAt: Date.now(),
					mailboxDir: handle.mailboxDir,
				});
			}
			revivedNames.push(member.name);
			revived += 1;
		}
		if (revivedNames.length > 0) {
			emitTorusCustom(
				{
					customType: "torus.delegation-start",
					content: [
						{
							type: "text",
							text: `@${revivedNames.join(", @")} respawned`,
						},
					],
					display: true,
					details: {
						agent: "team",
						handle: record.name,
						team: record.id,
						teamName: record.name,
						members: revivedNames,
					},
				},
				{ triggerTurn: false },
			);
		}
		record.status = "active";
		markTeamStatus(record.id, "active");
		return {
			content: [
				{
					type: "text",
					text: `revived ${revived} member(s) of ${record.id}; mailboxes and tasklist intact`,
				},
			],
			details: {},
		};
	},
});

function rehydrateTeam(teamId: string): TeamRecord | null {
	if (!AGENT_NAME_RE.test(teamId) || !listTeamIds().includes(teamId)) return null;
	const spec = readTeamSpec(teamId);
	if (!spec) return null;
	const record: TeamRecord = {
		id: teamId,
		name: spec.name,
		objective: spec.objective,
		status: spec.status === "shutdown" ? "shutdown" : "active",
		dir: teamDir(teamId),
		members: spec.members.map((member) => ({
			id: `${teamId}/${member.name}`,
			name: member.name,
			agent: member.agent,
			model: member.model ?? DEFAULT_MEMBER_MODEL,
			status: "stopped",
			sessionId: null,
			startedAt: 0,
			mailboxDir: path.join(teamDir(teamId), "mailboxes", member.name),
		})),
		createdAt: 0,
	};
	registerTeamRecord(record);
	return record;
}

function rehydrateAllTeams(): void {
	for (const teamId of listTeamIds()) {
		if (!getTeam(teamId)) rehydrateTeam(teamId);
	}
}

export function registerTeam(pi: ExtensionAPI): void {
	rehydrateAllTeams();
	pi.registerTool(fanoutTool);
	pi.registerTool(chainTool);
	pi.registerTool(teamCreateTool);
	pi.registerTool(teamStatusTool);
	pi.registerTool(teamMsgTool);
	pi.registerTool(teamTaskCreateTool);
	pi.registerTool(teamTaskListTool);
	pi.registerTool(teamTaskUpdateTool);
	pi.registerTool(teamDeleteTool);
	pi.registerTool(teamRespawnTool);
}

export default function teamExtension(pi: ExtensionAPI): void {
	registerTeam(pi);
}
