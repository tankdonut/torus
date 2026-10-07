/**
 * torus — plan-execution work state.
 *
 * Binds an active torus-plan plan file to the session so execution survives
 * compaction and restarts: progress is parsed live from the plan's column-zero
 * checkboxes (the plan stays the single source of truth — nothing is cached),
 * an append-only JSONL ledger records evidence, and an active-work context
 * block is injected into every turn until work_complete succeeds.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readJson, torusHome, writeJson } from "../fsutil.js";
import { currentSessionId } from "../registry.js";

const WORK_DIR = path.join(torusHome(), "work");

export type WorkStatus = "active" | "paused" | "complete";

export interface WorkState {
	slug: string;
	planPath: string;
	sessionId: string;
	status: WorkStatus;
	createdAt: number;
	startedAt: number;
	lastActiveAt: number;
	completedAt: number | null;
}

export type WorkEvent =
	| "start"
	| "task-done"
	| "verified"
	| "blocked"
	| "wave-gate"
	| "note"
	| "converge"
	| "complete";

export interface LedgerEntry {
	ts: string;
	sessionId: string;
	event: WorkEvent;
	text: string;
	wave?: string;
	task?: string;
	verification?: string;
	evidence?: string;
	verifiedBy?: string;
	/** How the plan was approved at binding: the marker text, or "assumed" (assumeApproved). */
	approval?: string;
}

export interface ParsedTask {
	/** 1-based line number of the checkbox row. */
	line: number;
	checked: boolean;
	title: string;
}

/** Column-zero checkbox rows only — indented rows are detail, not tasks. */
const TASK_RE = /^- \[( |x|X)\] (.*)$/;

/**
 * Column-zero approval marker: plain text by design, so it can never be
 * mistaken for (or collide with) a task checkbox row.
 */
const APPROVAL_RE = /^Approval: (.+)$/;

/** Parse a plan's machine-readable task rows: done/total progress + next task. */
export function parsePlanTasks(markdown: string): { tasks: ParsedTask[]; done: number } {
	const tasks: ParsedTask[] = [];
	const lines = markdown.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const match = TASK_RE.exec(lines[i] ?? "");
		if (!match) continue;
		const title = (match[2] ?? "").trim();
		if (title.length === 0) continue;
		tasks.push({ line: i + 1, checked: match[1] !== " ", title });
	}
	return { tasks, done: tasks.filter((t) => t.checked).length };
}

/**
 * Resolve a user-supplied plan reference: an absolute file path, or a stem
 * (full or unique prefix) under ~/.torus/plans. Errors carry candidates so
 * the caller can surface a selection instead of guessing.
 */
export function resolvePlan(ref: string): { planPath: string; slug: string } | { error: string } {
	const trimmed = ref.trim();
	if (trimmed.length === 0) return { error: "no plan reference given" };
	if (path.isAbsolute(trimmed)) {
		if (!fileExists(trimmed)) return { error: `plan file not found: ${trimmed}` };
		return { planPath: trimmed, slug: slugFor(trimmed) };
	}
	const plansDir = path.join(torusHome(), "plans");
	let candidates: string[] = [];
	try {
		candidates = readdirSync(plansDir)
			.filter((file) => file.endsWith(".md"))
			.sort();
	} catch {
		return { error: `no plans directory at ${plansDir} — pass an absolute plan path` };
	}
	const stems = candidates.map((file) => file.replace(/\.md$/, ""));
	const exact = stems.filter((stem) => stem === trimmed);
	if (exact.length === 1) return planResult(plansDir, exact[0] ?? trimmed);
	const prefix = stems.filter((stem) => stem.startsWith(trimmed));
	if (prefix.length === 1) return planResult(plansDir, prefix[0] ?? trimmed);
	if (prefix.length > 1) {
		return { error: `ambiguous plan "${trimmed}" — candidates: ${prefix.join(", ")}` };
	}
	return {
		error: `no plan matches "${trimmed}" — available: ${stems.slice(-8).join(", ") || "(none)"}`,
	};
}

function planResult(plansDir: string, stem: string): { planPath: string; slug: string } {
	return { planPath: path.join(plansDir, `${stem}.md`), slug: slugFor(stem) };
}

function fileExists(file: string): boolean {
	try {
		readFileSync(file, "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** State-file slug: the plan stem restricted to a filesystem-safe charset. */
function slugFor(stemOrPath: string): string {
	const stem = stemOrPath.endsWith(".md")
		? path.basename(stemOrPath, ".md")
		: path.basename(stemOrPath);
	const slug = stem
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 120);
	return slug.length > 0 ? slug : "plan";
}

function stateFile(slug: string): string {
	return path.join(WORK_DIR, `${slug}.json`);
}

function ledgerFile(slug: string): string {
	return path.join(WORK_DIR, `${slug}.ledger.jsonl`);
}

export function readWorkState(slug: string): WorkState | null {
	return readJson<WorkState | null>(stateFile(slug), null);
}

export function writeWorkState(state: WorkState): void {
	writeJson(stateFile(state.slug), state);
}

export function appendLedgerEntry(slug: string, entry: LedgerEntry): void {
	mkdirSync(WORK_DIR, { recursive: true });
	appendFileSync(ledgerFile(slug), `${JSON.stringify(entry)}\n`, "utf-8");
}

/** Last `n` ledger rows, newest last; corrupt lines are skipped, not fatal. */
export function readLedger(slug: string, n: number): LedgerEntry[] {
	let raw: string;
	try {
		raw = readFileSync(ledgerFile(slug), "utf-8");
	} catch {
		return [];
	}
	const rows: LedgerEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			rows.push(JSON.parse(trimmed) as LedgerEntry);
		} catch {
			// skip corrupt line
		}
	}
	return rows.slice(-n);
}

/** All work states on disk, newest lastActiveAt last. */
export function listWorkStates(): WorkState[] {
	let files: string[] = [];
	try {
		files = readdirSync(WORK_DIR).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const states = files
		.map((file) => readJson<WorkState | null>(path.join(WORK_DIR, file), null))
		.filter((state): state is WorkState => state !== null);
	return states.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
}

/** The work this session should advance: newest active binding, if any. */
export function activeWorkFor(sessionId: string | null): WorkState | null {
	if (!sessionId) return null;
	return (
		listWorkStates().findLast(
			(state) => state.sessionId === sessionId && state.status === "active",
		) ?? null
	);
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Gate for work_complete: null when every task row is checked, otherwise the
 * blocking-message string naming what remains.
 */
export function completionBlocker(markdown: string): string | null {
	const { tasks, done } = parsePlanTasks(markdown);
	if (tasks.length === 0) return "plan has no column-zero checkbox tasks to verify";
	if (done < tasks.length) {
		const remaining = tasks
			.filter((t) => !t.checked)
			.slice(0, 10)
			.map((t) => `- L${t.line}: ${t.title.slice(0, 80)}`);
		const more = tasks.length - done - remaining.length;
		return `plan still has ${tasks.length - done} unchecked task(s):\n${remaining.join("\n")}${
			more > 0 ? `\n- …and ${more} more` : ""
		}`;
	}
	return null;
}

/** The plan's approval marker value (e.g. "tankdonut 2026-10-07"), or null when it carries none. */
export function approvalMarker(markdown: string): string | null {
	for (const line of markdown.split("\n")) {
		const value = APPROVAL_RE.exec(line)?.[1]?.trim();
		if (value) return value;
	}
	return null;
}

/**
 * Gate for work_start: null when the plan carries an approval marker —
 * "Approval: <user/date>" from an accepted plan, or the recorded
 * "Approval: skipped (--yes)" escape — otherwise the blocking-message string.
 */
export function approvalBlocker(markdown: string): string | null {
	return approvalMarker(markdown) === null
		? 'plan lacks an approval marker (add a line "Approval: <user/date>", or "Approval: skipped (--yes)" to bind without review)'
		: null;
}

/**
 * Resolve a slug the way a dispatch text carries it: exact, else unique
 * prefix, else unique substring (leads paraphrase dated stems —
 * "release-workflow-implementation" for "2026-10-04-release-workflow-
 * implementation"). Ambiguity and misses list candidates so one retry fixes it.
 */
export function resolveLedgerSlug(slug: string): { slug: string } | { error: string } {
	const known = [...new Set(listWorkStates().map((state) => state.slug))];
	if (known.includes(slug)) return { slug };
	const matches = known.filter((s) => s.includes(slug));
	if (matches.length === 1) return { slug: matches[0] ?? slug };
	if (matches.length > 1) {
		return { error: `ambiguous work slug "${slug}" — candidates: ${matches.join(", ")}` };
	}
	return {
		error: `no work state for slug "${slug}" — known works: ${
			known.slice(-8).join(", ") || "(none)"
		} (the lead passes the exact slug in the dispatch text)`,
	};
}

/**
 * Validation for cross-session ledger appends (delegated builders writing to
 * a work they were told about by slug): the work must exist and be active.
 */
export function ledgerAppendError(slug: string): string | null {
	const resolved = resolveLedgerSlug(slug);
	if ("error" in resolved) return resolved.error;
	const state = readWorkState(resolved.slug);
	if (!state) return `no work state for slug "${resolved.slug}"`;
	if (state.status !== "active")
		return `work "${resolved.slug}" is ${state.status} — its ledger is closed`;
	return null;
}

/**
 * The per-turn active-work block. Rebuilt from disk every turn — this is what
 * makes execution survive compaction and session restarts.
 */
export function workContextBlock(sessionId: string | null): string {
	const state = activeWorkFor(sessionId);
	if (!state) return "";
	let markdown = "";
	try {
		markdown = readFileSync(state.planPath, "utf-8");
	} catch {
		return `[torus work — active plan execution]\nPlan MISSING at ${state.planPath} — surface this to the user before doing anything else.`;
	}
	const { tasks, done } = parsePlanTasks(markdown);
	const next = tasks.find((t) => !t.checked);
	const tail = readLedger(state.slug, 2);
	const tailLines =
		tail.length > 0
			? `\nLedger tail:\n${tail.map((e) => `- [${e.event}] ${e.text.slice(0, 120)}`).join("\n")}`
			: "";
	const elapsed = formatElapsed(Date.now() - state.startedAt);
	const nextLine = next
		? `Next: L${next.line} ${next.title.slice(0, 100)}`
		: "All tasks checked — run the plan's final verification wave, then work_complete";
	return `[torus work — active plan execution; the plan file is the contract, resume from it and the ledger, never from memory]
Plan: ${state.planPath} — ${done}/${tasks.length} tasks checked (${elapsed})
${nextLine}${tailLines}
Record evidence with work_note; only work_complete (which refuses while any task is unchecked) ends execution.`;
}

function refreshLastActive(state: WorkState): WorkState {
	return { ...state, lastActiveAt: Date.now() };
}

export function registerWork(pi: ExtensionAPI): void {
	const requireActive = (): { state: WorkState } | { error: string } => {
		const sessionId = currentSessionId();
		const state = activeWorkFor(sessionId);
		if (!state) {
			return {
				error:
					"no active work bound to this session — pass the work slug (delegated builders) or call work_start (lead) first",
			};
		}
		return { state: refreshLastActive(state) };
	};

	// Delegated child sessions get exactly one surface: work_note with an
	// explicit slug. Binding, resuming, and completing stay with the parent.
	const isChild = process.env["TORUS_ENGINE_CHILD"] === "1";

	if (!isChild) {
		pi.registerTool(
			defineTool({
				name: "work_start",
				label: "Work Start",
				description:
					'Bind a torus-plan plan file to this session as active work. Approval gate: refuses unless the plan carries a column-zero "Approval: <user/date>" line (or the recorded escape "Approval: skipped (--yes)"); assumeApproved binds without one and is journaled. Parses the plan\'s column-zero checkboxes, reports progress and the next task, and injects an active-work context block into every turn until work_complete. Rebinding an existing plan resumes it (elapsed time spans runs). Use with the torus-execute skill. Parent sessions only — delegated children never rebind work.',
				parameters: Type.Object({
					plan: Type.String({
						description:
							"Plan reference: absolute path, or the file stem (full or unique prefix) under ~/.torus/plans",
					}),
					assumeApproved: Type.Optional(
						Type.Boolean({
							description:
								'Bind without an approval marker because the user explicitly directed skipping review; recorded as approval: "assumed" in the start ledger row',
						}),
					),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
					const sessionId = currentSessionId();
					if (!sessionId) {
						return {
							content: [{ type: "text", text: "work: no session id available" }],
							details: {},
							isError: true,
						};
					}
					const resolved = resolvePlan(params.plan);
					if ("error" in resolved) {
						return {
							content: [{ type: "text", text: resolved.error }],
							details: {},
							isError: true,
						};
					}
					let markdown: string;
					try {
						markdown = readFileSync(resolved.planPath, "utf-8");
					} catch {
						return {
							content: [{ type: "text", text: `cannot read plan: ${resolved.planPath}` }],
							details: {},
							isError: true,
						};
					}
					const { tasks, done } = parsePlanTasks(markdown);
					if (tasks.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: "plan has no column-zero checkbox tasks (`- [ ] N. title`) — nothing to execute",
								},
							],
							details: {},
							isError: true,
						};
					}
					const assume = params.assumeApproved ?? false;
					const marker = approvalMarker(markdown);
					const blocker = assume ? null : approvalBlocker(markdown);
					if (blocker) {
						return {
							content: [{ type: "text", text: `REFUSED — ${blocker}` }],
							details: {},
							isError: true,
						};
					}
					const approval = assume ? "assumed" : (marker ?? "");
					const now = Date.now();
					const prior = readWorkState(resolved.slug);
					const state: WorkState = {
						slug: resolved.slug,
						planPath: resolved.planPath,
						sessionId,
						status: "active",
						createdAt: prior?.createdAt ?? now,
						startedAt: prior?.startedAt ?? now,
						lastActiveAt: now,
						completedAt: null,
					};
					writeWorkState(state);
					appendLedgerEntry(resolved.slug, {
						ts: new Date().toISOString(),
						sessionId,
						event: "start",
						text: prior ? "work rebound to a new session (resume)" : "work started",
						approval,
					});
					const next = tasks.find((t) => !t.checked);
					const body = [
						`${prior ? "Resumed" : "Started"}: ${resolved.planPath}`,
						`Progress: ${done}/${tasks.length} tasks checked (${formatElapsed(now - state.startedAt)} elapsed)`,
						next
							? `Next: L${next.line} ${next.title}`
							: "All tasks checked — run the final verification wave, then work_complete",
					].join("\n");
					return { content: [{ type: "text", text: body }], details: { slug: resolved.slug } };
				},
			}),
		);
	}

	pi.registerTool(
		defineTool({
			name: "work_note",
			label: "Work Note",
			description:
				"Append a typed evidence row to a work ledger (~/.torus/work/<slug>.ledger.jsonl). Without slug: the session's active work. With slug: that work — how delegated builders journal gotchas and decisions (the ledger is the plan's shared notepad; rows carry the writer's session id). Events: task-done (verification + evidence), verified (verifiedBy: lead|reviewer), blocked (blocker), wave-gate (command + exit code), note (anything durable), converge (cross-wave synthesis). Returns the tail for confirmation.",
			parameters: Type.Object({
				event: Type.Union(
					[
						Type.Literal("task-done"),
						Type.Literal("verified"),
						Type.Literal("blocked"),
						Type.Literal("wave-gate"),
						Type.Literal("note"),
						Type.Literal("converge"),
					],
					{ description: "Ledger row type" },
				),
				text: Type.String({ description: "One-line summary of what happened" }),
				wave: Type.Optional(Type.String({ description: "Wave id/name" })),
				task: Type.Optional(Type.String({ description: "Task id/title" })),
				verification: Type.Optional(
					Type.String({ description: "Command run + exit code or assertion result" }),
				),
				evidence: Type.Optional(Type.String({ description: "Artifact path" })),
				verifiedBy: Type.Optional(
					Type.String({ description: "lead or reviewer (the verifying context)" }),
				),
				slug: Type.Optional(
					Type.String({
						description:
							"Explicit work slug — append to that work's ledger from any session (the lead passes it in the dispatch text)",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const sessionId = currentSessionId() ?? "unknown";
				let slug: string;
				let touch: WorkState | null = null;
				if (params.slug !== undefined) {
					const resolved = resolveLedgerSlug(params.slug);
					if ("error" in resolved) {
						return {
							content: [{ type: "text", text: resolved.error }],
							details: {},
							isError: true,
						};
					}
					const error = ledgerAppendError(resolved.slug);
					if (error) {
						return { content: [{ type: "text", text: error }], details: {}, isError: true };
					}
					slug = resolved.slug;
				} else {
					const active = requireActive();
					if ("error" in active) {
						return {
							content: [{ type: "text", text: active.error }],
							details: {},
							isError: true,
						};
					}
					slug = active.state.slug;
					touch = active.state;
				}
				const entry: LedgerEntry = {
					ts: new Date().toISOString(),
					sessionId,
					event: params.event,
					text: params.text,
					...(params.wave !== undefined && { wave: params.wave }),
					...(params.task !== undefined && { task: params.task }),
					...(params.verification !== undefined && { verification: params.verification }),
					...(params.evidence !== undefined && { evidence: params.evidence }),
					...(params.verifiedBy !== undefined && { verifiedBy: params.verifiedBy }),
				};
				appendLedgerEntry(slug, entry);
				if (touch) writeWorkState(touch);
				const tail = readLedger(slug, 3)
					.map((e) => `[${e.event}] ${e.text.slice(0, 120)}`)
					.join("\n");
				return { content: [{ type: "text", text: `ledger appended:\n${tail}` }], details: {} };
			},
		}),
	);

	if (!isChild) {
		pi.registerTool(
			defineTool({
				name: "work_complete",
				label: "Work Complete",
				description:
					"Parent sessions only. Mark the session's active plan execution complete. Machine gate: refuses while ANY column-zero checkbox in the plan is unchecked (or the plan is missing), listing what remains. On success records elapsed time, appends the complete ledger row, and stops the per-turn work block.",
				parameters: Type.Object({
					summary: Type.String({
						description:
							"Evidence of completion: waves shipped, verification summary, residual risks",
					}),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
					const active = requireActive();
					if ("error" in active) {
						return {
							content: [{ type: "text", text: active.error }],
							details: {},
							isError: true,
						};
					}
					let markdown: string;
					try {
						markdown = readFileSync(active.state.planPath, "utf-8");
					} catch {
						return {
							content: [
								{
									type: "text",
									text: `plan MISSING at ${active.state.planPath} — resolve the plan before completing`,
								},
							],
							details: {},
							isError: true,
						};
					}
					const blocker = completionBlocker(markdown);
					if (blocker) {
						return {
							content: [{ type: "text", text: `REFUSED — ${blocker}` }],
							details: {},
							isError: true,
						};
					}
					const now = Date.now();
					const state: WorkState = {
						...active.state,
						status: "complete",
						lastActiveAt: now,
						completedAt: now,
					};
					writeWorkState(state);
					const { tasks } = parsePlanTasks(markdown);
					const ledgerRows = readLedger(state.slug, Number.POSITIVE_INFINITY).length;
					appendLedgerEntry(state.slug, {
						ts: new Date().toISOString(),
						sessionId: currentSessionId() ?? "unknown",
						event: "complete",
						text: params.summary.slice(0, 500),
					});
					const body = [
						"WORK COMPLETE",
						`PLAN: ${state.planPath}`,
						`TASKS: ${tasks.length}/${tasks.length}`,
						`ELAPSED: ${formatElapsed(now - state.startedAt)}`,
						`LEDGER ROWS: ${ledgerRows}`,
					].join("\n");
					return { content: [{ type: "text", text: body }], details: { complete: true } };
				},
			}),
		);
	}

	pi.on("context", (event) => {
		const block = workContextBlock(currentSessionId());
		if (!block) return undefined;
		event.messages.push({
			role: "user",
			content: [{ type: "text", text: block }],
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});
}

export default function workExtension(pi: ExtensionAPI): void {
	registerWork(pi);
}
