/**
 * torus — session handoff.
 *
 * Long-lived sessions (roadmap iteration over many plan slices) accumulate
 * transcript that the next slice has no use for. Compaction is the mid-flight
 * fallback; a slice boundary is a cheaper cut point: the plan and its ledger
 * live on disk, so a fresh session rehydrates everything except the goal (and
 * an in-flight work binding, both keyed by session id) and starts with a
 * curated context instead of a summarized one.
 *
 * Session replacement (`ctx.newSession`) is a command-context operation, so
 * the LLM cannot switch sessions from a tool directly. The engine's sanctioned
 * pattern applies instead: the `handoff_session` tool records the request and
 * ends the run, and the `agent_settled` handler dispatches `/handoff` as a
 * command (`pi.sendUserMessage` with `expandPromptTemplates`), which executes
 * once the runtime is available. In an autonomous goal session this is the
 * whole point: the model itself chooses to start the next plan slice in a new
 * session. `/handoff` stays available as the manual fallback.
 *
 * The command runs the composite quiet-boundary gate before switching. Bare
 * `isIdle()` is not enough: the session idles while children run, and the wake
 * gate may hold entries (run-active backlog or the idle coalesce window) that
 * would wake the replaced session id and strand — spool files drain only when
 * their own session starts again. So the gate also requires an empty wake
 * gate, no queued messages, and no live delegations, monitors, or bg tasks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GoalState, readGoal, writeGoal } from "../goal/index.js";
import { liveTaskCount } from "../monitor/index.js";
import { gateExtension, isEngineChild, type PlatformSupport } from "../platform.js";
import { currentSessionId, listDelegations } from "../registry.js";
import { wakeGatePendingCount } from "../wake-gate.js";
import { listWorkStates, type WorkState, writeWorkState } from "../work/index.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

/** Context-use percentage at or above which the settle-time note fires. */
export const NOTIFY_FRACTION_PCT = 50;

/**
 * Inputs to the recommendation: current context use (percent of window), the
 * newest completed work binding for this session, and the completedAt value
 * the note last fired for.
 */
export interface HandoffSnapshot {
	percent: number | null;
	completedAt: number | null;
	lastNotifiedAt: number | null;
}

/**
 * The one-time post-completion note, or null when there is nothing to say:
 * no completed work, a completion already announced, or context use under
 * the threshold (a session about to end gains nothing from a fresh start).
 */
export function handoffRecommendation(snapshot: HandoffSnapshot): string | null {
	if (snapshot.completedAt == null) return null;
	if (snapshot.lastNotifiedAt != null && snapshot.completedAt <= snapshot.lastNotifiedAt)
		return null;
	if (snapshot.percent == null || snapshot.percent < NOTIFY_FRACTION_PCT) return null;
	return `handoff: context at ${Math.round(snapshot.percent)}% after completing plan execution; /handoff [brief] continues in a fresh session`;
}

/**
 * The composite quiet-boundary gate. Null means the handoff may proceed;
 * otherwise the refusal text naming the condition that is still open.
 */
export interface HandoffGate {
	isIdle: boolean;
	pendingMessages: boolean;
	wakePending: number;
	liveTasks: number;
	runningDelegations: number;
}

export function handoffBlocker(gate: HandoffGate): string | null {
	if (!gate.isIdle) return "handoff: wait for the current run to settle first";
	if (gate.pendingMessages) return "handoff: queued messages present; let them deliver first";
	if (gate.wakePending > 0)
		return `handoff: ${gate.wakePending} wake marker(s) pending delivery; let them deliver first`;
	if (gate.runningDelegations > 0)
		return `handoff: ${gate.runningDelegations} delegation(s) still running; let them finish first`;
	if (gate.liveTasks > 0)
		return `handoff: ${gate.liveTasks} live monitor/bg task(s); stop them first`;
	return null;
}

/** The brief the handoff carries: explicit command args win over a tool request. */
export function resolveBrief(args: string, pendingBrief: string | null): string {
	if (args.trim().length > 0) return args;
	return pendingBrief ?? "";
}

/** Copy the session goal to a new session id; false when the source has none. */
export function copyGoalToSession(fromId: string, toId: string): boolean {
	const state = readGoal(fromId);
	if (!state) return false;
	writeGoal(toId, { ...state });
	return true;
}

/**
 * Re-point an active work binding at a new session id, so a mid-plan handoff
 * resumes the plan instead of orphaning it; null when nothing is active.
 */
export function rebindWorkToSession(fromId: string, toId: string): WorkState | null {
	const active =
		listWorkStates().findLast((state) => state.sessionId === fromId && state.status === "active") ??
		null;
	if (!active) return null;
	const rebound = { ...active, sessionId: toId };
	writeWorkState(rebound);
	return rebound;
}

/**
 * The kickoff prompt the replacement session receives: continuity note, the
 * standing objective when one exists, then the caller's brief (or a
 * continue-as-before default when none was given).
 */
export function kickoffText(brief: string, goal: GoalState | null): string {
	const lines = [
		"[torus handoff] This session continues a previous session (parent link in the session header). The prior transcript is not carried over; durable state re-injects per turn.",
	];
	if (goal && goal.goal.trim().length > 0) {
		lines.push(`Standing objective (${goal.status}): ${goal.goal}`);
	}
	if (brief.trim().length > 0) {
		lines.push(brief.trim());
	} else {
		lines.push("Continue the standing work from where the previous session left off.");
	}
	return lines.join("\n\n");
}

export function registerHandoff(pi: ExtensionAPI): void {
	/** completedAt of the completion the note last fired for. */
	let lastNotifiedAt: number | null = null;
	/** Brief passed to handoff_session, consumed by the dispatched /handoff. */
	let pendingBrief: string | null = null;
	/** Whether the settle-time note already fired this runtime. */
	let announced = false;

	pi.registerTool(
		defineTool({
			name: "handoff_session",
			label: "Handoff Session",
			description:
				"Start the next piece of work in a FRESH session, replacing this one. Choose this at a slice boundary when the current context has grown large (roadmap iteration, after work_complete): the replacement session copies the standing objective, resumes any active plan binding, and receives your brief as its kickoff prompt, while the accumulated transcript stays behind. Pass brief = the concrete instruction for the next slice (what to plan or execute next). The handoff happens after this response settles and only from a quiet boundary (no pending wakes, runs, or live tasks); if the boundary is not quiet yet, the request is refused and you stay here. Not available to delegated children.",
			parameters: Type.Object({
				brief: Type.Optional(
					Type.String({ description: "Kickoff instruction for the replacement session" }),
				),
			}),
			async execute(_toolCallId, params) {
				if (isEngineChild()) {
					return {
						content: [{ type: "text", text: "handoff_session runs in parent sessions only." }],
						details: {},
						isError: true,
					};
				}
				pendingBrief = typeof params.brief === "string" ? params.brief : null;
				return {
					content: [
						{
							type: "text",
							text: "Handoff requested. This session is replaced by a fresh session carrying your brief after this response settles.",
						},
					],
					details: {},
					terminate: true,
				};
			},
		}),
	);

	pi.on("agent_settled", (_event, ctx) => {
		if (isEngineChild()) return;
		if (pendingBrief !== null) {
			pendingBrief = null;
			pi.sendUserMessage("/handoff", { expandPromptTemplates: true });
			return;
		}
		const sessionId = currentSessionId();
		const usage = ctx.getContextUsage();
		const percent = usage?.percent ?? null;
		if (percent == null || percent < NOTIFY_FRACTION_PCT || announced) return;
		const completed = sessionId
			? listWorkStates().findLast(
					(state) =>
						state.sessionId === sessionId &&
						state.status === "complete" &&
						state.completedAt != null,
				)
			: undefined;
		const goal = sessionId ? readGoal(sessionId) : null;
		const goalActive = goal?.status === "active" && goal.goal.trim().length > 0;
		if (!completed && !goalActive) return;
		let note: string | null;
		if (completed) {
			note = handoffRecommendation({
				percent,
				completedAt: completed.completedAt,
				lastNotifiedAt,
			});
			if (note) lastNotifiedAt = completed.completedAt;
		} else {
			note = `handoff: context at ${Math.round(percent)}% with an active goal; /handoff starts the next slice in a fresh session`;
		}
		if (!note) return;
		announced = true;
		ctx.ui.notify(note, "info");
	});

	pi.registerCommand("handoff", {
		description:
			"Continue in a fresh session: /handoff [brief] copies the goal, rebinds active work, and sends a kickoff prompt",
		handler: async (args, ctx) => {
			const blocker = handoffBlocker({
				isIdle: ctx.isIdle(),
				pendingMessages: ctx.hasPendingMessages(),
				wakePending: wakeGatePendingCount(),
				liveTasks: liveTaskCount(),
				runningDelegations: listDelegations().filter((record) => record.status === "running")
					.length,
			});
			if (blocker) {
				ctx.ui.notify(blocker, "warning");
				return;
			}
			const fromId = currentSessionId();
			const parentSession = ctx.sessionManager.getSessionFile();
			if (!fromId || !parentSession) {
				ctx.ui.notify("handoff: no session id available", "error");
				return;
			}
			const goal = readGoal(fromId);
			const kickoff = kickoffText(resolveBrief(args, pendingBrief), goal);
			pendingBrief = null;
			const result = await ctx.newSession({
				parentSession,
				setup: async (sm) => {
					const toId = sm.getSessionId();
					copyGoalToSession(fromId, toId);
					rebindWorkToSession(fromId, toId);
				},
				withSession: async (next) => {
					await next.sendUserMessage(kickoff);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("handoff: replacement session was cancelled", "warning");
			}
		},
	});
}

export default function handoffExtension(pi: ExtensionAPI): void {
	if (!gateExtension("handoff", PLATFORM_SUPPORT)) return;
	registerHandoff(pi);
}
