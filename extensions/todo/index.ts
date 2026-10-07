import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";

const TODO_DIR = path.join(homedir(), ".torus", "todo");
const SESSION_KEY = Symbol.for("torus.current-session");

interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority?: "high" | "medium" | "low";
}

function todoFile(sessionId: string): string {
	return path.join(TODO_DIR, `${sessionId}.json`);
}

export function readTodos(sessionId: string): TodoItem[] {
	try {
		const parsed = JSON.parse(readFileSync(todoFile(sessionId), "utf8")) as { todos?: TodoItem[] };
		return Array.isArray(parsed.todos) ? parsed.todos : [];
	} catch {
		return [];
	}
}

function writeTodos(sessionId: string, todos: TodoItem[]): void {
	mkdirSync(TODO_DIR, { recursive: true });
	writeFileSync(todoFile(sessionId), JSON.stringify({ todos }, null, 2), "utf8");
}

export function todoContextBlock(sessionId: string | null): string {
	if (!sessionId) return "";
	const todos = readTodos(sessionId).filter((t) => t.status !== "completed");
	if (todos.length === 0) return "";
	const lines = todos.map((t) => {
		const icon = t.status === "completed" ? "●" : t.status === "in_progress" ? "◐" : "○";
		return `- ${icon} (${t.priority ?? "medium"}) ${t.content}`;
	});
	return `[torus todos — the live task list; work it top-down, keep exactly one in_progress, update via torus_todowrite after each change; when all are complete, clear the list]\n${lines.join("\n")}`;
}

function currentSession(ctx?: ExtensionContext): string | null {
	if (ctx) {
		const id = ctx.sessionManager.getSessionId();
		(globalThis as Record<symbol, unknown>)[SESSION_KEY] = id;
		return id;
	}
	return ((globalThis as Record<symbol, unknown>)[SESSION_KEY] as string | null) ?? null;
}

function pendingCount(todos: TodoItem[]): number {
	return todos.filter((t) => t.status !== "completed").length;
}

const todoWriteTool = defineTool({
	name: "torus_todowrite",
	label: "Torus TodoWrite",
	description:
		"Replace the session todo list (write-only, full list every call). Update after every status change; clear by writing an empty list when everything is done.",
	parameters: Type.Object({
		todos: Type.Array(
			Type.Object({
				content: Type.String(),
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
				]),
				priority: Type.Optional(
					Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
				),
			}),
			{ maxItems: 30 },
		),
	}),
	renderResult(result, { expanded }, theme) {
		const todos = ((result.details ?? {}) as { todos?: TodoItem[] }).todos ?? [];
		if (todos.length === 0) {
			return new Text(theme.fg("dim", "todos cleared ●"), 0, 0);
		}
		const done = todos.filter((t) => t.status === "completed").length;
		const summary = `${theme.bold("todos")} ${theme.fg("success", `●${done}`)} ${theme.fg("dim", `/ ${todos.length}`)}`;
		if (!expanded && todos.length > 6) {
			return new Text(`${summary} ${theme.fg("dim", "(expand for the list)")}`, 0, 0);
		}
		const lines = todos.map((t) => {
			const prio =
				t.priority === "high"
					? theme.fg("error", "!")
					: t.priority === "low"
						? theme.fg("dim", "·")
						: " ";
			if (t.status === "completed") {
				return `${prio} ${theme.fg("success", "●")} ${STRIKE_ON}${theme.fg("dim", t.content)}${STRIKE_OFF}`;
			}
			if (t.status === "in_progress") {
				return `${prio} ${theme.fg("warning", "◐")} ${theme.bold(t.content)}`;
			}
			return `${prio} ${theme.fg("dim", "○")} ${t.content}`;
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
		writeTodos(sessionId, params.todos);
		const pending = pendingCount(params.todos);
		ctx.ui.setStatus(
			"torus:todo",
			pending > 0 ? `todos ●${params.todos.length - pending} ○${pending}` : undefined,
		);
		return {
			content: [{ type: "text", text: `${pending} pending of ${params.todos.length}` }],
			details: { todos: params.todos },
		};
	},
});

export function registerTodo(pi: ExtensionAPI): void {
	pi.registerTool(todoWriteTool);

	pi.on("session_start", (_event, ctx) => {
		currentSession(ctx);
		const sessionId = currentSession();
		const todos = readTodos(sessionId ?? "");
		const pending = pendingCount(todos);
		if (pending > 0) ctx.ui.setStatus("torus:todo", `todos ●${todos.length - pending} ○${pending}`);
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
	registerTodo(pi);
}
