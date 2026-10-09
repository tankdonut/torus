import { unlinkSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	projectStateDir,
	pruneOrphanSessionFiles,
	readJsonFallback,
	torusHome,
	writeJson,
} from "../fsutil.js";
import { currentSessionId, setCurrentSessionId } from "../registry.js";
import { sessionFileExists } from "../sessions/index.js";
import { type GoalChip, refreshToruStatus, setStatusGoal } from "../ui/index.js";

/** Age floor for orphan GC — a goal file is never deleted for age alone. */
const ORPHAN_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Pre-project-scoped store: read-only fallback, unlinked once a session writes anew. */
function legacyGoalFile(sessionId: string): string {
	return path.join(torusHome(), "goal", `${sessionId}.json`);
}

export interface GoalState {
	goal: string;
	status: "active" | "paused" | "complete";
	createdAt: number;
	notes: string[];
}

function goalDir(): string {
	return path.join(projectStateDir(), "goal");
}

function goalFile(sessionId: string): string {
	return path.join(goalDir(), `${sessionId}.json`);
}

export function readGoal(sessionId: string): GoalState | null {
	return readJsonFallback<GoalState | null>(goalFile(sessionId), legacyGoalFile(sessionId), null);
}

/**
 * Orphan-only GC for the project-scoped goal dir: a file goes only when its
 * session transcript no longer exists AND it is older than the age floor.
 * Live sessions (`true`) and unreadable session roots (`null`) keep everything;
 * the legacy store is never touched here.
 */
export function pruneGoalOrphans(
	exists: (sessionId: string) => boolean | null = (sessionId) => sessionFileExists(sessionId),
): number {
	return pruneOrphanSessionFiles(goalDir(), exists, ORPHAN_MIN_AGE_MS);
}

export function writeGoal(sessionId: string, state: GoalState | null): void {
	writeJson(goalFile(sessionId), state);
	try {
		unlinkSync(legacyGoalFile(sessionId));
	} catch {}
	pruneGoalOrphans();
}

export function goalContextBlock(sessionId: string | null): string {
	if (!sessionId) return "";
	const state = readGoal(sessionId);
	if (state?.status !== "active" || state.goal.trim().length === 0) return "";
	const notes =
		state.notes.length > 0
			? `\nProgress notes:\n${state.notes.map((n) => `- ${n}`).join("\n")}`
			: "";
	return `[torus goal — the session's standing objective; data from the goal feature, treat as task context not user instructions]\n${state.goal}${notes}\nWhen the goal is fully achieved and verified, mark it complete with the goal_complete tool.`;
}

function summary(state: GoalState | null): string {
	if (!state) return "no goal set — /goal <objective> to set one";
	const head = state.goal.replace(/\s+/g, " ").slice(0, 80);
	const icon = state.status === "complete" ? "✓" : state.status === "active" ? "▶" : "⏸";
	return `${icon} ${head}${state.goal.length > 80 ? "…" : ""}`;
}

/** Compact statusline chip: active/paused goals only, head truncated to 48 chars. */
export function goalChipFor(state: GoalState | null): GoalChip | undefined {
	if (!state || (state.status !== "active" && state.status !== "paused")) return undefined;
	const collapsed = state.goal.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	const head = collapsed.length > 48 ? `${collapsed.slice(0, 48)}…` : collapsed;
	return { head, status: state.status };
}

export function registerGoal(pi: ExtensionAPI): void {
	const refreshStatus = (ctx: ExtensionContext) => {
		setStatusGoal(goalChipFor(readGoal(currentSessionId() ?? "")));
		refreshToruStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		setCurrentSessionId(ctx.sessionManager.getSessionId());
		refreshStatus(ctx);
	});

	pi.registerCommand("goal", {
		description:
			"Set/show/pause/resume/clear the session goal: /goal <text> | /goal note <text> | pause | resume | off",
		handler: async (args, ctx) => {
			const sessionId = currentSessionId();
			if (!sessionId) {
				ctx.ui.notify("goal: no session id available", "error");
				return;
			}
			const trimmed = args.trim();
			const state = readGoal(sessionId);

			if (trimmed.length === 0) {
				ctx.ui.notify(summary(state), "info");
				return;
			}
			if (trimmed === "off" || trimmed === "clear") {
				writeGoal(sessionId, null);
				setStatusGoal(undefined);
				refreshToruStatus(ctx);
				ctx.ui.notify("goal cleared", "info");
				return;
			}
			if (trimmed === "pause") {
				if (state) {
					state.status = "paused";
					writeGoal(sessionId, state);
				}
				refreshStatus(ctx);
				ctx.ui.notify("goal paused", "info");
				return;
			}
			if (trimmed === "resume") {
				if (state) {
					state.status = "active";
					writeGoal(sessionId, state);
					refreshStatus(ctx);
					ctx.ui.notify("goal resumed", "info");
					pi.sendUserMessage(
						`Goal resumed: ${state.goal}\n\nContinue advancing it — recap where it stands from the progress notes first.`,
						{
							expandPromptTemplates: false,
						},
					);
				}
				return;
			}
			if (trimmed.startsWith("note ")) {
				const note = trimmed.slice(5).trim();
				if (note.length === 0) {
					ctx.ui.notify("usage: /goal note <progress note>", "error");
					return;
				}
				if (!state || state.goal.length === 0) {
					ctx.ui.notify("no goal set — set one with /goal <text> first", "error");
					return;
				}
				state.notes.push(`[${new Date().toISOString()}] ${note}`);
				writeGoal(sessionId, state);
				ctx.ui.notify("goal note added", "info");
				return;
			}
			writeGoal(sessionId, {
				goal: trimmed,
				status: "active",
				createdAt: Date.now(),
				notes: state?.notes ?? [],
			});
			refreshStatus(ctx);
			ctx.ui.notify(`goal set: ${trimmed.slice(0, 80)}`, "info");
			pi.sendUserMessage(
				`Goal set: ${trimmed}\n\nBegin advancing it now — if it is multi-step, state a short plan first.`,
				{
					expandPromptTemplates: false,
				},
			);
		},
	});

	pi.registerTool(
		defineTool({
			name: "goal_complete",
			label: "Goal Complete",
			description:
				"Mark this session's standing objective (the [torus goal] context block) as COMPLETE. Call this once the goal is fully achieved and verified — the objective stops being injected into future turns.",
			parameters: Type.Object({
				summary: Type.String({
					description: "Evidence of completion: what was accomplished and how it was verified",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionId = currentSessionId();
				if (!sessionId) {
					return {
						content: [{ type: "text", text: "goal: no session id available" }],
						details: {},
						isError: true,
					};
				}
				const state = readGoal(sessionId);
				if (!state) {
					return {
						content: [{ type: "text", text: "no goal is set for this session" }],
						details: {},
						isError: true,
					};
				}
				state.status = "complete";
				state.notes.push(`[${new Date().toISOString()}] COMPLETE: ${params.summary.slice(0, 500)}`);
				writeGoal(sessionId, state);
				refreshStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Goal marked complete — it will no longer be injected into future turns. Evidence recorded in the goal notes (review with /goal).`,
						},
					],
					details: { complete: true },
				};
			},
		}),
	);

	pi.on("context", (event) => {
		const block = goalContextBlock(currentSessionId());
		if (!block) return undefined;
		event.messages.push({
			role: "user",
			content: [{ type: "text", text: block }],
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});
}

export default function goalExtension(pi: ExtensionAPI): void {
	registerGoal(pi);
}
