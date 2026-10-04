import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectedServerCount, mcpStatusText } from "../mcp/index.js";
import { providerAvailabilities } from "../providers/index.js";
import { sessionPersona } from "../registry.js";

export const STATUS_KEY = "torus";

type AppTheme = ExtensionContext["ui"]["theme"];
export type StatusPainter = Pick<AppTheme, "fg" | "bold">;

/** Delegation tool executions that count toward the in-flight statusline chip. */
const DELEGATION_TOOLS = new Set(["torus_delegate", "torus_fanout", "torus_chain"]);

/** In-flight delegation tool executions; parallel fanouts must not wipe each other's indicator. */
let delegateInFlight = 0;

/** Current model / thinking effort, seeded from ctx and kept fresh via events. */
let currentModel: string | undefined;
let currentEffort: string | undefined;

/** MCP connected/registered counts; refreshed on session_start + turn_start and by the settle-poll below. */
let mcpCounts = { connected: 0, registered: 0 };

/**
 * Settle-poll timer: MCP connections come up in the background after session_start and pi emits
 * no event when one connects (mcp_servers_change fires only on register/unregister), so without
 * polling the first statusline paint would show MCP 0 until the first prompt's turn_start.
 */
let mcpPollTimer: ReturnType<typeof setInterval> | undefined;

/** Active or paused session goal, pushed by the goal extension; complete/unset drops the segment. */
export interface GoalChip {
	head: string;
	status: "active" | "paused";
}
let goalChip: GoalChip | undefined;

/**
 * Persona colors are raw RGB (truecolor) rather than theme keys: distinct
 * keys can resolve to identical colors in a theme (observed collisions made
 * personas indistinguishable), and raw values keep the editor border and the
 * statusline chip exactly in sync on every surface.
 */
export const PERSONA_COLORS: Record<string, [number, number, number]> = {
	leader: [86, 182, 194],
	builder: [80, 250, 123],
	explorer: [241, 196, 15],
	librarian: [189, 147, 249],
	reviewer: [255, 85, 85],
	dreamer: [255, 121, 198],
	looker: [142, 200, 255],
};

export function personaFg(persona: string, text: string): string {
	const rgb = PERSONA_COLORS[persona];
	if (!rgb) return text;
	const [r, g, b] = rgb;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Test/interop hook: set the model+effort state the statusline renders. */
export function setStatusModel(model: string | undefined, effort: string | undefined): void {
	currentModel = model;
	currentEffort = effort;
}

/** Test/interop hook: set the MCP counts and goal chip the statusline renders. */
export function setStatusExtras(
	mcp: { connected: number; registered: number } | null,
	goal: GoalChip | null,
): void {
	mcpCounts = mcp ?? { connected: 0, registered: 0 };
	goalChip = goal ?? undefined;
}

/** Prod hook for the goal extension: replace the rendered goal chip. */
export function setStatusGoal(goal: GoalChip | undefined): void {
	goalChip = goal;
}

/** Test/interop hook: whether the post-session_start MCP settle-poll is still running. */
export function mcpSettlePollActive(): boolean {
	return mcpPollTimer !== undefined;
}

function shortModelId(id: string): string {
	const slash = id.indexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

export function buildStatus(theme?: StatusPainter): string {
	const available = providerAvailabilities();
	const engine = process.env["TORUS_ENGINE"] ?? "pi";
	const providers =
		(["zai", "opencode-go"] as const).filter((p) => available[p]).join("|") || "no-keys";
	const persona = sessionPersona();

	const sep = theme ? theme.fg("dim", " · ") : " · ";
	const brand = theme ? theme.fg("accent", theme.bold("torus")) : "torus";

	const segments = [brand];
	// identity block: persona, model, and thinking effort share the persona
	// color so the active configuration reads as one group; model ids are
	// shortened ("zai/glm-4.7" -> "glm-4.7") to keep the line short
	const modelText = currentModel ? shortModelId(currentModel) : undefined;
	if (persona) {
		segments.push(personaFg(persona, persona));
		if (modelText) segments.push(personaFg(persona, modelText));
		if (currentEffort) segments.push(personaFg(persona, currentEffort));
	} else if (modelText) {
		segments.push(theme ? theme.fg("dim", modelText) : modelText);
	}
	segments.push(theme ? theme.fg("dim", providers) : providers);
	// the stock engine is the norm — tag the line only when overridden
	if (engine !== "pi") {
		segments.push(theme ? theme.fg("dim", `[${engine}]`) : `[${engine}]`);
	}
	const mcpText = mcpStatusText(mcpCounts.connected, mcpCounts.registered);
	if (mcpText) {
		const color = mcpCounts.connected > 0 ? "success" : "warning";
		segments.push(theme ? theme.fg(color, mcpText) : mcpText);
	}
	if (goalChip) {
		const icon = goalChip.status === "active" ? "▶" : "⏸";
		const text = `${icon} ${goalChip.head}`;
		const color = goalChip.status === "active" ? "warning" : "dim";
		segments.push(theme ? theme.fg(color, text) : text);
	}
	if (delegateInFlight > 0) {
		const tag = delegateInFlight > 1 ? `delegate ×${delegateInFlight}` : "delegate";
		segments.push(theme ? theme.fg("warning", tag) : tag);
	}
	return segments.join(sep);
}

/**
 * Single render path for the torus statusline key: backfills missing
 * model/effort state from live ctx, then paints. Self-heals the case where
 * the initial selection never reached our listeners (restore-before-load,
 * same-model persona switch, setModel refused for missing auth).
 */
export function refreshToruStatus(ctx: ExtensionContext): void {
	currentModel ??= ctx.model?.id;
	currentEffort ??= ctx.thinkingLevel;
	ctx.ui.setStatus(STATUS_KEY, buildStatus(ctx.ui.theme));
}

export function registerUi(pi: ExtensionAPI): void {
	const refreshMcp = () => {
		const registered = pi.getMcpServers().map((server) => server.name);
		mcpCounts = {
			connected: connectedServerCount(registered, pi.getActiveTools()),
			registered: registered.length,
		};
	};

	const stopMcpPoll = () => {
		if (mcpPollTimer !== undefined) {
			clearInterval(mcpPollTimer);
			mcpPollTimer = undefined;
		}
	};

	/** Poll until every registered server is connected (or the deadline passes), repainting on change. */
	const pollMcpUntilSettled = (ctx: ExtensionContext) => {
		stopMcpPoll();
		const deadline = Date.now() + 30_000;
		const timer = setInterval(() => {
			const before = mcpCounts.connected;
			refreshMcp();
			if (mcpCounts.connected !== before) refreshToruStatus(ctx);
			const settled = mcpCounts.registered === 0 || mcpCounts.connected >= mcpCounts.registered;
			if (settled || Date.now() >= deadline) stopMcpPoll();
		}, 250);
		// never hold the process (or a test run) open just for this poll
		timer.unref?.();
		mcpPollTimer = timer;
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		currentModel = ctx.model?.id;
		currentEffort = ctx.thinkingLevel;
		refreshMcp();
		pollMcpUntilSettled(ctx);
		refreshToruStatus(ctx);
	});

	pi.on("turn_start", (_event, ctx: ExtensionContext) => {
		refreshMcp();
		refreshToruStatus(ctx);
	});

	pi.on("model_select", (event, ctx: ExtensionContext) => {
		currentModel = event.model.id;
		refreshToruStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx: ExtensionContext) => {
		currentEffort = event.level;
		refreshToruStatus(ctx);
	});

	pi.on("tool_execution_start", (event, ctx: ExtensionContext) => {
		if (DELEGATION_TOOLS.has(event.toolName)) {
			delegateInFlight += 1;
			refreshToruStatus(ctx);
		}
	});

	pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
		if (DELEGATION_TOOLS.has(event.toolName)) {
			delegateInFlight = Math.max(0, delegateInFlight - 1);
			if (delegateInFlight === 0) refreshToruStatus(ctx);
		}
	});
}

export default function uiExtension(pi: ExtensionAPI): void {
	registerUi(pi);
}
