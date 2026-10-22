import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	projectStateDir,
	pruneOrphanSessionFiles,
	readJsonFallback,
	torusHome,
} from "../fsutil.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { sessionFileExists } from "../sessions/index.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";

const ORPHAN_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_KEY = Symbol.for("torus.current-session");

/** Paraphrase match floor for containment similarity between two items. */
const MATCH_FLOOR = 0.8;

export interface TodoItem {
	id?: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority?: "high" | "medium" | "low";
}

/** Write shape: status "dropped" removes the matched item instead of updating it. */
export type TodoInput = Omit<TodoItem, "status"> & { status: TodoItem["status"] | "dropped" };

export interface TodoStats {
	/** Distinct items ever assigned an id: the progress denominator never shrinks. */
	tracked: number;
	/** High-water mark of completed items; survives removals and clears. */
	donePeak: number;
	nextId: number;
}

export interface TodoState {
	todos: TodoItem[];
	stats: TodoStats;
	done: number;
	pending: number;
}

interface TodoFile {
	todos?: TodoItem[];
	stats?: Partial<TodoStats>;
}

function todoDir(): string {
	return path.join(projectStateDir(), "todo");
}

/** Todos live under the current project's state dir, resolved per call — sessions can cd. */
function todoFile(sessionId: string): string {
	return path.join(todoDir(), `${sessionId}.json`);
}

/** Pre-project-layout todo location, still read when the project file is absent. */
function legacyTodoFile(sessionId: string): string {
	return path.join(torusHome(), "todo", `${sessionId}.json`);
}

export function readTodoState(sessionId: string): TodoState {
	const parsed = readJsonFallback<TodoFile>(todoFile(sessionId), legacyTodoFile(sessionId), {});
	const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
	const raw = parsed.stats ?? {};
	const stats: TodoStats = {
		tracked: Math.max(0, Number(raw.tracked) || 0),
		donePeak: Math.max(0, Number(raw.donePeak) || 0),
		nextId: Math.max(1, Number(raw.nextId) || 1),
	};
	const done = todos.filter((t) => t.status === "completed").length;
	return { todos, stats, done, pending: todos.length - done };
}

export function readTodos(sessionId: string): TodoItem[] {
	return readTodoState(sessionId).todos;
}

function persistTodos(sessionId: string, todos: TodoItem[], stats: TodoStats): void {
	const file = todoFile(sessionId);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ todos, stats }, null, 2), "utf8");
	try {
		unlinkSync(legacyTodoFile(sessionId));
	} catch {}
	pruneTodoOrphans();
}

function normTokens(content: string): string[] {
	return content
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

function containment(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const setB = new Set(b);
	const hits = a.filter((t) => setB.has(t)).length;
	return hits / Math.min(a.length, b.length);
}

/**
 * Merge a full-list write against the stored list. Matching is by id first,
 * then exact normalized content, then containment similarity, so a paraphrase
 * updates the original item instead of forking a duplicate. Omitted completed
 * items are retained while the list has open items (the model cannot lose
 * finished work by dropping it from a rewrite); once every stored item is
 * completed the list is closed and omitted items are no longer re-attached,
 * so the next write starts a fresh list. Omitted pending items are removed as
 * intentional; status "dropped" removes explicitly; an empty write clears
 * everything.
 */
export function writeTodos(sessionId: string, incoming: TodoInput[]): TodoState {
	const state = readTodoState(sessionId);
	let nextId = state.stats.nextId;
	const clearing = incoming.length === 0;
	/** Stored list with every item completed: closed, so omitted items are not re-attached. */
	const listWasDone = state.todos.length > 0 && state.pending === 0;

	const prev = state.todos.map((t) => (t.id ? t : { ...t, id: `t${nextId++}` }));
	const pool = prev.map((item) => ({
		item,
		norm: normTokens(item.content).join(" "),
		tokens: normTokens(item.content),
		used: false,
	}));

	const findMatch = (candidate: TodoInput): number => {
		const norm = normTokens(candidate.content).join(" ");
		let idx = candidate.id ? pool.findIndex((p) => !p.used && p.item.id === candidate.id) : -1;
		if (idx >= 0) return idx;
		if (norm) {
			idx = pool.findIndex((p) => !p.used && p.norm === norm);
			if (idx >= 0) return idx;
		} else {
			return -1;
		}
		const ctokens = normTokens(candidate.content);
		let best = -1;
		let bestScore = MATCH_FLOOR;
		for (const [i, p] of pool.entries()) {
			if (p.used) continue;
			const score = Math.max(containment(ctokens, p.tokens), containment(p.tokens, ctokens));
			if (score > bestScore) {
				best = i;
				bestScore = score;
			}
		}
		return best;
	};

	const merged: TodoItem[] = [];
	let droppedCompleted = 0;

	for (const input of incoming) {
		const idx = findMatch(input);
		const match = idx >= 0 ? pool[idx] : null;
		if (match) match.used = true;
		if (input.status === "dropped") {
			if (match?.item.status === "completed") droppedCompleted++;
			continue;
		}
		if (match) {
			const priority = input.priority ?? match.item.priority;
			merged.push({
				id: match.item.id,
				content: input.content,
				status: input.status,
				...(priority ? { priority } : {}),
			});
		} else {
			merged.push({
				id: `t${nextId++}`,
				content: input.content,
				status: input.status,
				...(input.priority ? { priority: input.priority } : {}),
			});
		}
	}

	for (const p of pool) {
		if (p.used) continue;
		if (!clearing && !listWasDone && p.item.status === "completed") merged.push(p.item);
	}

	const done = merged.filter((t) => t.status === "completed").length;
	const stats: TodoStats = {
		tracked: Math.max(state.stats.tracked, nextId - 1),
		donePeak: Math.max(state.stats.donePeak, done + droppedCompleted),
		nextId,
	};
	persistTodos(sessionId, merged, stats);
	return { todos: merged, stats, done, pending: merged.length - done };
}

/** Orphan-only GC: never age-prune, never touch the legacy dir. */
export function pruneTodoOrphans(
	exists: (sessionId: string) => boolean | null = sessionFileExists,
): number {
	return pruneOrphanSessionFiles(todoDir(), exists, ORPHAN_MIN_AGE_MS);
}

export function todoContextBlock(sessionId: string | null): string {
	if (!sessionId) return "";
	const { todos, stats } = readTodoState(sessionId);
	if (todos.length === 0) return "";
	const active = todos.filter((t) => t.status !== "completed");
	const doneItems = todos.filter((t) => t.status === "completed");
	if (active.length === 0) {
		return `[torus todos — every item complete (●${doneItems.length} of ${stats.tracked} done): the list is closed and the next torus_todowrite starts a fresh list]`;
	}
	const lines = [...active, ...doneItems].map((t) => {
		const icon = t.status === "completed" ? "●" : t.status === "in_progress" ? "◐" : "○";
		return `- ${icon} ${t.id ?? "?"} (${t.priority ?? "medium"}) ${t.content}`;
	});
	const header = [
		"[torus todos — the live task list; work it top-down, keep exactly one in_progress,",
		"update via torus_todowrite after each change. Re-include every item in each write,",
		"completed ones too (same id, status completed): completed items omitted from a write are",
		"kept while open items remain, pending ones omitted are removed; mark an item status",
		'"dropped" to remove it explicitly; once every item is completed the list closes and',
		"the next write starts a fresh list]",
	].join("\n");
	return `${header}\n${lines.join("\n")}`;
}

function currentSession(ctx?: ExtensionContext): string | null {
	if (ctx) {
		const id = ctx.sessionManager.getSessionId();
		(globalThis as Record<symbol, unknown>)[SESSION_KEY] = id;
		return id;
	}
	return ((globalThis as Record<symbol, unknown>)[SESSION_KEY] as string | null) ?? null;
}

function chipText(state: TodoState): string | undefined {
	if (state.pending === 0 && state.todos.length === 0) return undefined;
	const base = `todos ●${state.done} ○${state.pending}`;
	return state.stats.tracked > state.todos.length ? `${base} of ${state.stats.tracked}` : base;
}

const todoWriteTool = defineTool({
	name: "torus_todowrite",
	label: "Torus TodoWrite",
	description:
		'Update the session todo list (full list every call). Items match prior ones by id, then by content, so paraphrases update instead of duplicating. Completed items omitted from the write are kept while the list has open items; pending items omitted are removed; status "dropped" removes an item explicitly. Always re-include completed items (same id, status "completed") while work continues; once every item is completed the list closes and the next write starts fresh (re-including a completed item by id still carries it across). An empty list clears everything immediately.',
	parameters: Type.Object({
		todos: Type.Array(
			Type.Object({
				id: Type.Optional(Type.String()),
				content: Type.String(),
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
					Type.Literal("dropped"),
				]),
				priority: Type.Optional(
					Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
				),
			}),
			{ maxItems: 30 },
		),
	}),
	renderResult(result, { expanded }, theme) {
		const state = ((result.details ?? {}) as { state?: TodoState }).state;
		if (!state || state.todos.length === 0) {
			return new Text(theme.fg("dim", "todos cleared ●"), 0, 0);
		}
		const summary = `${theme.bold("todos")} ${theme.fg("success", `●${state.done}`)} ${theme.fg("dim", `/ ${state.stats.tracked}`)}`;
		if (!expanded && state.todos.length > 6) {
			return new Text(`${summary} ${theme.fg("dim", "(expand for the list)")}`, 0, 0);
		}
		const lines = state.todos.map((t) => {
			const prio =
				t.priority === "high"
					? theme.fg("error", "!")
					: t.priority === "low"
						? theme.fg("dim", "·")
						: " ";
			if (t.status === "completed") {
				return `${prio} ${theme.fg("success", "●")} ${STRIKE_ON}${theme.fg("dim", `${t.id ?? "?"} ${t.content}`)}${STRIKE_OFF}`;
			}
			if (t.status === "in_progress") {
				return `${prio} ${theme.fg("warning", "◐")} ${theme.bold(`${t.id ?? "?"} ${t.content}`)}`;
			}
			return `${prio} ${theme.fg("dim", "○")} ${t.id ?? "?"} ${t.content}`;
		});
		return new Text(`${summary}\n${lines.join("\n")}`, 0, 0);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const sessionId = currentSession(ctx);
		if (!sessionId) {
			return {
				content: [{ type: "text", text: "no session id — todos unavailable" }],
				details: {},
				isError: true,
			};
		}
		const state = writeTodos(sessionId, params.todos);
		ctx.ui.setStatus("torus:todo", chipText(state));
		return {
			content: [
				{
					type: "text",
					text:
						state.todos.length === 0
							? `cleared · ${state.stats.donePeak}/${state.stats.tracked} done all-time`
							: `${state.pending} pending · ${state.done}/${state.stats.tracked} done`,
				},
			],
			details: { state },
		};
	},
});

export function registerTodo(pi: ExtensionAPI): void {
	pi.registerTool(todoWriteTool);

	pi.on("session_start", (_event, ctx) => {
		currentSession(ctx);
		const sessionId = currentSession();
		if (!sessionId) return;
		ctx.ui.setStatus("torus:todo", chipText(readTodoState(sessionId)));
	});

	pi.on("context", (event) => {
		const block = todoContextBlock(currentSession());
		if (!block) return undefined;
		event.messages.push({
			role: "user",
			content: [{ type: "text", text: block }],
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});
}

export default function todoExtension(pi: ExtensionAPI): void {
	if (!gateExtension("todo", PLATFORM_SUPPORT)) return;
	registerTodo(pi);
}
