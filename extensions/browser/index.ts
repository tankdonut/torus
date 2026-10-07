import { Type } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	entityColor,
	flattenPreview,
	formatDuration,
	formatTokens,
	rule,
	SPINNER,
	shortModel,
	statusIcon,
	type Theme,
} from "../fleet/theme-kit.js";
import {
	type DelegationRecord,
	type ExternalRun,
	FLEET_OPENER,
	listDelegations,
	listExternalRuns,
	listExternalRunsExcludingDelegations,
	sanitizeRender,
	steerDelegation,
	stopDelegation,
} from "../registry.js";
import {
	liveTail,
	type TranscriptItem,
	transcriptItems,
	transcriptMtimeMs,
} from "../transcript.js";

type ToolDefinitionLike = ConstructorParameters<typeof ToolExecutionComponent>[4];

const TOOL_DEFINITION_FACTORIES: Record<string, (cwd: string) => ToolDefinitionLike> = {
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	find: createFindToolDefinition,
	grep: createGrepToolDefinition,
	ls: createLsToolDefinition,
	powershell: createPowerShellToolDefinition,
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
};

const toolDefinitionCache = new Map<string, ToolDefinitionLike>();

function torusToolDefinition(
	name: string,
	title: (args: Record<string, unknown>) => string,
): ToolDefinitionLike {
	return defineTool({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		renderCall(args) {
			return new Text(title(args as Record<string, unknown>), 0, 0);
		},
		async execute() {
			return { content: [{ type: "text", text: `${name} (replayed)` }], details: {} };
		},
	}) as unknown as ToolDefinitionLike;
}

const TORUS_TOOL_DEFINITIONS: Record<string, ToolDefinitionLike> = {
	torus_delegate: torusToolDefinition(
		"torus_delegate",
		(args) =>
			`delegate ${String(args["agent"] ?? "?")} · ${sanitizeRender(flattenPreview(args["task"], 60))}`,
	),
	torus_fanout: torusToolDefinition(
		"torus_fanout",
		(args) => `fan-out ${Array.isArray(args["runs"]) ? args["runs"].length : "?"} runs`,
	),
	torus_chain: torusToolDefinition(
		"torus_chain",
		(args) => `chain ${Array.isArray(args["steps"]) ? args["steps"].length : "?"} steps`,
	),
	torus_roster: torusToolDefinition("torus_roster", () => "roster"),
	hashline_edit: torusToolDefinition("hashline_edit", (args) => {
		const file =
			String(args["path"] ?? "?")
				.split("/")
				.pop() ?? "?";
		if (args["delete"] === true) return `hashline ${file} · delete`;
		const count = Array.isArray(args["edits"]) ? args["edits"].length : 0;
		return `hashline ${file} · ${count} op${count === 1 ? "" : "s"}`;
	}),
	interactive_bash: torusToolDefinition(
		"interactive_bash",
		(args) => `tty ${sanitizeRender(flattenPreview(args["command"], 48))}`,
	),
	team_create: torusToolDefinition(
		"team_create",
		(args) => `team create ${String(args["name"] ?? "?")}`,
	),
	team_status: torusToolDefinition("team_status", () => "team status"),
	team_msg: torusToolDefinition(
		"team_msg",
		(args) =>
			`team msg → ${String(args["to"] ?? "?")} · ${sanitizeRender(flattenPreview(args["text"], 50))}`,
	),
	team_delete: torusToolDefinition("team_delete", () => "team delete"),
	team_respawn: torusToolDefinition("team_respawn", () => "team respawn"),
	team_task_create: torusToolDefinition(
		"team_task_create",
		(args) => `task+ ${sanitizeRender(flattenPreview(args["subject"], 60))}`,
	),
	team_task_list: torusToolDefinition("team_task_list", () => "tasks"),
	team_task_update: torusToolDefinition(
		"team_task_update",
		(args) => `task ${String(args["task"] ?? "?")} → ${String(args["status"] ?? "?")}`,
	),
};

function builtinToolDefinition(name: string): ToolDefinitionLike | undefined {
	const torus = TORUS_TOOL_DEFINITIONS[name];
	if (torus) return torus;
	if (!(name in TOOL_DEFINITION_FACTORIES)) return undefined;
	let definition = toolDefinitionCache.get(name);
	if (!definition) {
		const factory = TOOL_DEFINITION_FACTORIES[name];
		if (factory) definition = factory(process.cwd());
		if (definition) toolDefinitionCache.set(name, definition);
	}
	return definition;
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";

// Scoped mouse takeover: SGR wheel reporting on while the overlay owns the screen.
// Fullscreen never writes these: the host TUI owns the mouse mode set
// (1000/1002/1004/1006, plus 1003 outside multiplexers) and any write from
// here — enable or disable — can clobber it and kill host clicks until restart.
const ENABLE_WHEEL = "\x1b[?1000h\x1b[?1006h";
const DISABLE_WHEEL = "\x1b[?1006l\x1b[?1000l";
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
// Wheel sequences can arrive split across reads; hold a strict prefix until it completes.
const PARTIAL_SGR_MOUSE = /^\x1b\[<\d*(?:;\d*){0,2}$/;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const WHEEL_LINES = 3;

type FleetItem =
	| { kind: "delegation"; record: DelegationRecord }
	| { kind: "external"; run: ExternalRun };

function headerLine(record: DelegationRecord, theme: Theme, tick: number, width: number): string {
	const color = entityColor(record.handle ?? record.agent);
	const icon = statusIcon(theme, record.status, tick);
	const who = record.handle
		? `@${sanitizeRender(record.handle)} (${sanitizeRender(record.agent)})`
		: sanitizeRender(record.agent);
	const name = theme.fg(color, theme.bold(who));
	const model = theme.fg("dim", sanitizeRender(shortModel(record.model)));
	const age = Math.round((Date.now() - record.startedAt) / 1000);
	const ran =
		record.status !== "running" && record.finishedAt !== undefined
			? ` · ${formatDuration(record.finishedAt - record.startedAt)}`
			: "";
	const stats =
		record.status === "running"
			? `turn ${record.turns} · ${formatTokens(record.tokensIn)}→${formatTokens(record.tokensOut)} tok · ${age}s`
			: `${record.turns} turns · ${formatTokens(record.tokensIn)}→${formatTokens(record.tokensOut)} tok${ran}`;
	return truncateToWidth(`${icon} ${name} ${model} — ${stats}`, width);
}

export function splitMouseBuffer(
	combined: string,
	wheel: (delta: -1 | 1) => void,
): { keys: string; held: string } {
	let rest = combined.replace(SGR_MOUSE, (_match, button: string) => {
		const code = Number(button);
		if (code === WHEEL_UP) wheel(-1);
		else if (code === WHEEL_DOWN) wheel(1);
		return "";
	});
	// A mouse-shaped prefix followed by content that can neither finish a CSI
	// sequence (final byte 0x40–0x7e, e.g. the A/B of arrow keys) nor continue
	// its parameter run (0x30–0x3f) is a dead fragment — dropping it keeps a
	// split read from swallowing the next key, e.g. ESC after a split wheel event.
	rest = rest.replace(/\x1b\[(?:<)?[\d;]*(?=[^\x30-\x7e])/g, "");
	if (PARTIAL_SGR_MOUSE.test(rest)) return { keys: "", held: rest };
	return { keys: rest, held: "" };
}

function withinSpan(x: number, span: readonly [number, number] | undefined): boolean {
	return span !== undefined && x >= span[0] && x <= span[1];
}

/** The footer's back affordance: colored text, click-routed like the buttons. */
const BACK_LABEL = "[esc] back";

/** Screen-space span for BACK_LABEL at `leadWidth` visible columns into the
 * footer line — undefined when the label would be clipped by `width`. */
function backSpan(leadWidth: number, width: number): [number, number] | undefined {
	const start = leadWidth + 3; // the dim " · " separator before the label
	return start + BACK_LABEL.length <= width ? [start, start + BACK_LABEL.length - 1] : undefined;
}

class FleetBrowser implements Component {
	private tui: TUI;
	private theme: Theme;
	private done: (result: undefined) => void;
	private cursor = 0;
	private mode: "list" | "detail" = "list";
	private scroll = 0;
	/** Top row of the list window; follows the cursor so every item stays reachable. */
	private listScroll = 0;
	private follow = true;
	private detailMaxScroll = 0;
	private pendingMouse = "";
	private items: FleetItem[] = [];
	/** Overlay-local row y → items index, rebuilt by renderList for click-to-open. */
	private listRows = new Map<number, number>();
	private tick = 0;
	private steerMode = false;
	private steerText = "";
	/** One-key stop guard: y confirms stopDelegation, anything else cancels. */
	private stopConfirm = false;
	/** Hovered list row index / footer button for bold-on-hover; null = none. */
	private hoverRow: number | null = null;
	private hoverButton: "steer" | "stop" | "back" | null = null;
	/** Screen-space hit-boxes in the detail footer line: the [steer]/[stop]
	 * buttons and the colored back label, each present only when fully rendered. */
	private footerButtons: {
		y: number;
		steer?: [number, number];
		stop?: [number, number];
		back?: [number, number];
	} | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly componentCache = new Map<
		string,
		{ mtimeMs: number | undefined; component: Component; resultApplied?: boolean }
	>();
	/** True once the list view has actually been shown: esc from detail goes back
	 * to the list only when the user came through it, otherwise it closes. */
	private listSeen = false;

	constructor(
		tui: TUI,
		theme: Theme,
		done: (result: undefined) => void,
		focusDelegationId: string | null = null,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		if (focusDelegationId) {
			const index = listDelegations().findIndex((record) => record.id === focusDelegationId);
			if (index >= 0) {
				this.cursor = index;
				this.mode = "detail";
			}
		}
		// A detail opened straight from a strip click has no list behind it.
		this.listSeen = this.mode !== "detail";
		this.timer = setInterval(() => {
			this.tick += 1;
			this.tui.requestRender();
		}, 80);
		if (tui.mode !== "fullscreen") process.stdout.write(ENABLE_WHEEL);
	}

	dispose(): void {
		// Undo only what the constructor enabled. In fullscreen the host owns
		// the mouse modes and we enabled nothing — writing a disable here (the
		// old hostMouse heuristic misfired on pi 1.0.0's unset default) killed
		// host clicks on the main screen after the overlay closed.
		if (this.tui.mode !== "fullscreen") process.stdout.write(DISABLE_WHEEL);
		if (this.timer) clearInterval(this.timer);
	}

	invalidate(): void {}

	private close(): void {
		this.done(undefined);
	}

	handleInput(data: string): void {
		const remainder = this.consumeMouse(data);
		if (remainder.length === 0) {
			this.tui.requestRender();
			return;
		}
		data = remainder;
		const selected = this.items[this.cursor];
		if (this.stopConfirm) {
			if (data === "y" || data === "Y") {
				if (selected?.kind === "delegation" && selected.record.status === "running")
					stopDelegation(selected.record.id);
				this.stopConfirm = false;
			} else if (data === "n" || data === "N" || data === ESC || data === "q" || data === CTRL_C) {
				this.stopConfirm = false;
			}
			this.tui.requestRender();
			return;
		}
		if (this.mode === "detail") {
			const record = selected?.kind === "delegation" ? selected.record : undefined;
			if (this.steerMode) {
				if (data === ENTER) {
					if (record && this.steerText.trim().length > 0) {
						steerDelegation(record.id, this.steerText.trim());
					}
					this.steerMode = false;
					this.steerText = "";
				} else if (data === ESC) {
					this.steerMode = false;
					this.steerText = "";
				} else if (data.startsWith("\x1b")) {
					// navigation/escape sequence (arrows etc.) — neither text nor exit
				} else if (data === "\x7f" || data === "\b") {
					this.steerText = this.steerText.slice(0, -1);
				} else {
					const printable = [...data].filter((ch) => {
						const code = ch.codePointAt(0) ?? 0;
						return code >= 32 && code !== 127;
					});
					this.steerText += printable.join("");
				}
				this.tui.requestRender();
				return;
			}
			if (data === ESC || data === "q" || data === CTRL_C || data === ENTER) {
				// Back to the list only when the user came through it; a detail opened
				// directly from a strip click returns straight to the main TUI.
				if (this.listSeen) this.mode = "list";
				else this.close();
			} else if (data === "s") {
				if (record && record.status === "running") {
					this.steerMode = true;
					this.steerText = "";
				}
			} else if (data === "x") {
				if (record && record.status === "running") this.stopConfirm = true;
			} else if (data === UP || data === "k") {
				this.follow = false;
				this.scroll = Math.max(0, this.scroll - 1);
			} else if (data === DOWN || data === "j") {
				this.scroll += 1;
			} else if (data === "g") {
				this.follow = false;
				this.scroll = 0;
			} else if (data === "G") {
				this.follow = true;
			} else if (data === " ") {
				this.follow = false;
				this.scroll += 10;
			} else if (data === "b") {
				this.follow = false;
				this.scroll = Math.max(0, this.scroll - 10);
			}
			this.tui.requestRender();
			return;
		}

		if (data === ESC || data === "q" || data === CTRL_C) {
			this.close();
		} else if (data === ENTER) {
			if (this.items.length > 0) {
				this.mode = "detail";
				this.follow = true;
				this.scroll = 0;
			}
		} else if (data === "x") {
			if (selected?.kind === "delegation" && selected.record.status === "running")
				this.stopConfirm = true;
		} else if (data === UP || data === "k") {
			this.cursor = Math.max(0, this.cursor - 1);
		} else if (data === DOWN || data === "j") {
			this.cursor = Math.min(Math.max(0, this.items.length - 1), this.cursor + 1);
		}
		this.tui.requestRender();
	}

	/** Host-dispatched mouse (fullscreen): wheel scrolls, clicks open list rows.
	 * Regular mode never calls this — wheel arrives as raw SGR in handleInput. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const lines = event.wheelDelta ?? 0;
			if (lines !== 0) this.applyWheel(lines);
			return { handled: true };
		}
		if (event.type === "move") {
			let changed = false;
			const row = this.mode === "list" ? (this.listRows.get(event.y) ?? null) : null;
			const button =
				this.footerButtons && this.mode === "detail" && event.y === this.footerButtons.y
					? withinSpan(event.x, this.footerButtons.steer)
						? "steer"
						: withinSpan(event.x, this.footerButtons.stop)
							? "stop"
							: withinSpan(event.x, this.footerButtons.back)
								? "back"
								: null
					: null;
			if (row !== this.hoverRow) {
				this.hoverRow = row;
				changed = true;
			}
			if (button !== this.hoverButton) {
				this.hoverButton = button;
				changed = true;
			}
			if (changed) this.tui.requestRender();
			return undefined;
		}
		if (
			event.type === "click" &&
			event.button === "left" &&
			this.mode === "detail" &&
			this.footerButtons &&
			event.y === this.footerButtons.y
		) {
			if (withinSpan(event.x, this.footerButtons.back)) {
				// Same as pressing esc: leave steer/stop states, or back out of detail.
				if (this.steerMode) {
					this.steerMode = false;
					this.steerText = "";
				} else if (this.stopConfirm) {
					this.stopConfirm = false;
				} else if (this.listSeen) {
					this.mode = "list";
				} else {
					this.close();
				}
				this.tui.requestRender();
				return { handled: true };
			}
			const selected = this.items[this.cursor];
			const running = selected?.kind === "delegation" && selected.record.status === "running";
			if (running && withinSpan(event.x, this.footerButtons.steer)) {
				this.steerMode = true;
				this.steerText = "";
				this.tui.requestRender();
				return { handled: true };
			}
			if (running && withinSpan(event.x, this.footerButtons.stop)) {
				this.stopConfirm = true;
				this.tui.requestRender();
				return { handled: true };
			}
			return undefined;
		}
		if (event.type === "click" && event.button === "left" && this.mode === "list") {
			const index = this.listRows.get(event.y);
			if (index === undefined || index >= this.items.length) return undefined;
			this.cursor = index;
			this.mode = "detail";
			this.follow = true;
			this.scroll = 0;
			return { handled: true };
		}
		return undefined;
	}

	private consumeMouse(chunk: string): string {
		const combined = this.pendingMouse + chunk;
		this.pendingMouse = "";
		const { keys, held } = splitMouseBuffer(combined, (delta) => this.wheel(delta));
		this.pendingMouse = held;
		return keys;
	}

	private wheel(delta: -1 | 1): void {
		this.applyWheel(delta * WHEEL_LINES);
	}

	/** Signed logical lines; negative scrolls toward the top. */
	private applyWheel(lines: number): void {
		if (this.mode === "detail") {
			if (lines < 0) this.follow = false;
			this.scroll = Math.max(0, this.scroll + lines);
			if (this.scroll >= this.detailMaxScroll) this.follow = true;
		} else {
			const step = lines < 0 ? -1 : 1;
			this.cursor = Math.min(Math.max(0, this.items.length - 1), Math.max(0, this.cursor + step));
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const records = listDelegations();
		const runningExternals = listExternalRunsExcludingDelegations().filter(
			(r) => r.state === "running",
		);
		this.items = [
			...records.map((record) => ({ kind: "delegation" as const, record })),
			...runningExternals.map((run) => ({ kind: "external" as const, run })),
		];
		if (this.items.length > 0) this.cursor = Math.min(this.cursor, this.items.length - 1);
		const detailItem = this.mode === "detail" ? this.items[this.cursor] : undefined;
		const frameColor = detailItem
			? entityColor(
					detailItem.kind === "delegation"
						? (detailItem.record.handle ?? detailItem.record.agent)
						: (detailItem.run.handle ?? detailItem.run.label),
				)
			: undefined;
		const frameRule = rule(theme, Math.max(0, width), frameColor ?? "dim");
		let body: string[];
		if (this.mode === "detail" && this.items.length > 0) {
			const item = this.items[this.cursor];
			body = item
				? this.renderDetail(item, theme, width)
				: this.renderList(records, runningExternals, theme, width);
		} else {
			body = this.renderList(records, runningExternals, theme, width);
		}
		// The overlay covers only what it renders — pad to full terminal height or the editor stays visible underneath.
		const rows = process.stdout.rows ?? 40;
		const framed = [frameRule, ...body.slice(0, -1), frameRule, "", ""];
		while (framed.length < rows) framed.push("");
		return framed.slice(0, Math.max(1, rows));
	}

	private renderList(
		records: DelegationRecord[],
		externals: ExternalRun[],
		theme: Theme,
		width: number,
	): string[] {
		this.listRows.clear();
		const mouse = this.tui.mode === "fullscreen";
		const bar = theme.fg("dim", "─".repeat(Math.max(0, Math.min(width - 2, 72))));
		const lines: string[] = [
			`${theme.bold("torus fleet")} ${theme.fg("dim", `· ↑↓ move · enter${mouse ? "/click" : ""} open · x stop (y/n) · esc close`)}`,
			bar,
		];
		/** items index → row in `lines`, for click routing and cursor windowing. */
		const itemRow = new Map<number, number>();

		if (records.length === 0) {
			lines.push(theme.fg("dim", "no delegations yet · try /explorer <task>"));
		}
		for (const [index, record] of records.entries()) {
			const pointer = index === this.cursor ? theme.fg("accent", "❯ ") : "  ";
			itemRow.set(index, lines.length);
			const row = `${pointer}${headerLine(record, theme, this.tick, width)}`;
			lines.push(index === this.hoverRow ? theme.bold(row) : row);
		}

		if (externals.length > 0) {
			lines.push(bar, theme.fg("dim", `team members / external runs (${externals.length}):`));
			for (const [index, run] of externals.entries()) {
				const pointer = this.cursor === records.length + index ? theme.fg("accent", "❯ ") : "  ";
				const age = Math.round((Date.now() - run.startedAt) / 1000);
				const icon = theme.fg("warning", SPINNER[this.tick % SPINNER.length] ?? "•");
				const who = theme.fg(
					entityColor(run.handle ?? run.label),
					`@${sanitizeRender(run.handle ?? run.label)}`,
				);
				const model = theme.fg("dim", run.model ? sanitizeRender(shortModel(run.model)) : "");
				const body = `${icon} ${who} ${model} — turn ${run.turns ?? 0} · ${formatTokens(run.tokensIn ?? 0)}→${formatTokens(run.tokensOut ?? 0)} tok`;
				const tail = theme.fg("dim", ` · [${run.source}] ${age}s`);
				itemRow.set(records.length + index, lines.length);
				const row = `  ${pointer}${truncateToWidth(body + tail, width - 4)}`;
				lines.push(this.hoverRow === records.length + index ? theme.bold(row) : row);
			}
		}

		// The list shows the whole fleet: window the rows around the cursor so
		// every item stays reachable by key, wheel, and click no matter how many
		// runs exist. Frame rules, the scroll hint, the stop prompt, and the
		// trailing blank live outside the window.
		const available = Math.max(3, (process.stdout.rows ?? 40) - 5 - (this.stopConfirm ? 1 : 0));
		this.listScroll = Math.max(0, Math.min(this.listScroll, lines.length - available));
		const cursorRow = itemRow.get(this.cursor) ?? 0;
		if (cursorRow < this.listScroll) this.listScroll = cursorRow;
		else if (cursorRow >= this.listScroll + available) this.listScroll = cursorRow - available + 1;
		const above = this.listScroll;
		const below = lines.length - Math.min(lines.length, this.listScroll + available);
		for (const [item, row] of itemRow) {
			if (row >= this.listScroll && row < this.listScroll + available) {
				this.listRows.set(row - this.listScroll + 1, item); // +1: top frame rule
			}
		}
		const out = lines.slice(this.listScroll, this.listScroll + available);
		if (above > 0 || below > 0) {
			const parts = [`↑↓/j/k ${this.cursor + 1}/${this.items.length}`];
			if (above > 0) parts.push(`↑${above} above`);
			if (below > 0) parts.push(`+${below} more`);
			out.push(theme.fg("dim", parts.join(" · ")));
		}
		if (this.stopConfirm) {
			const selected = this.items[this.cursor];
			const who =
				selected?.kind === "delegation"
					? selected.record.handle
						? `@${selected.record.handle}`
						: selected.record.agent
					: "?";
			out.push(` ${theme.fg("error", theme.bold(`stop ${who}? y/n`))}`);
		}
		out.push("");
		return out;
	}

	private componentForItem(sessionId: string, item: TranscriptItem): Component | null {
		const cacheKey = `${sessionId}:${item.kind}:${item.id}`;
		// transcriptItems caches by file mtime; an entry built against an older
		// transcript (e.g. an assistant message that grew) must be dropped, or the
		// first snapshot renders forever.
		const mtimeMs = transcriptMtimeMs(sessionId);
		let cached = this.componentCache.get(cacheKey);
		if (cached && cached.mtimeMs !== mtimeMs) {
			this.componentCache.delete(cacheKey);
			cached = undefined;
		}
		if (item.kind === "user") {
			if (!cached || !(cached.component instanceof UserMessageComponent)) {
				cached = { mtimeMs, component: new UserMessageComponent(item.text) };
				this.componentCache.set(cacheKey, cached);
			}
			return cached.component;
		}
		if (item.kind === "assistant") {
			if (!cached || !(cached.component instanceof AssistantMessageComponent)) {
				cached = { mtimeMs, component: new AssistantMessageComponent(item.message) };
				this.componentCache.set(cacheKey, cached);
			}
			return cached.component;
		}
		if (!cached || !(cached.component instanceof ToolExecutionComponent)) {
			const component = new ToolExecutionComponent(
				item.name,
				item.toolCallId,
				item.args,
				{},
				builtinToolDefinition(item.name),
				this.tui,
				process.cwd(),
			);
			cached = { mtimeMs, component };
			this.componentCache.set(cacheKey, cached);
		}
		const component = cached.component as ToolExecutionComponent;
		if (item.output !== undefined && !cached.resultApplied) {
			component.updateResult({
				content: [{ type: "text", text: item.output }],
				details: item.details,
				isError: item.isError === true,
			});
			cached.resultApplied = true;
		}
		return component;
	}

	private renderDetail(item: FleetItem, theme: Theme, width: number): string[] {
		const rows = process.stdout.rows ?? 40;
		// rows - 4 feeds the outer frame (top rule, bottom rule, two blank rows);
		// one more row stays blank between the transcript and the footer rule — the
		// same breathing room the main session window keeps above the editor border.
		const visible = Math.max(1, rows - 5);
		const body =
			item.kind === "delegation"
				? this.delegationDetailBody(item.record, theme, width)
				: this.externalDetailBody(item.run, theme, width);
		if (this.follow) this.scroll = Math.max(0, body.length - visible);
		this.scroll = Math.min(this.scroll, Math.max(0, body.length - visible));
		this.detailMaxScroll = Math.max(0, body.length - visible);
		const page = body.slice(this.scroll, this.scroll + visible);
		const canSteer = item.kind === "delegation" && item.record.status === "running";
		const stopPrompt = this.stopConfirm && canSteer;
		// Footer rows under the transcript: one blank padding row + rule + status
		// line; the steer box and the y/n stop prompt each claim one extra row.
		const reserved = this.steerMode && canSteer ? 5 : stopPrompt ? 4 : 3;
		const filler = Math.max(0, visible - page.length - reserved);
		const steerColor = entityColor(
			item.kind === "delegation"
				? (item.record.handle ?? item.record.agent)
				: (item.run.handle ?? item.run.label),
		);
		const frameRule = rule(theme, Math.max(0, width), steerColor);
		const header =
			item.kind === "delegation"
				? this.delegationHeader(
						item.record,
						theme,
						width,
						canSteer && !this.steerMode && !stopPrompt,
					)
				: this.externalHeader(item.run, theme, width);
		let footer: string[];
		// The header call above already left footerButtons holding exactly the
		// zones it rendered — back-only in steer/stop states, back+buttons otherwise.
		if (this.steerMode && canSteer) {
			const input = ` ${theme.fg(steerColor, `steer> ${this.steerText}█`)}`;
			footer = [frameRule, input, frameRule, header];
		} else if (stopPrompt && item.kind === "delegation") {
			const who = item.record.handle ? `@${item.record.handle}` : item.record.agent;
			footer = [` ${theme.fg("error", theme.bold(`stop ${who}? y/n`))}`, frameRule, header];
		} else {
			footer = [frameRule, header];
		}
		// One blank row keeps the transcript clear of the footer rule.
		const gap = [""];
		const result = [...page, ...new Array<string>(filler).fill(""), ...gap, ...footer, ""];
		// Status line is the last footer row; the outer render() adds one rule above it.
		if (this.footerButtons)
			this.footerButtons.y = 1 + page.length + filler + gap.length + footer.length - 1;
		return result;
	}

	/** Detail footer status line. With `buttons`, the colored [steer]/[stop] pair
	 * renders inline where the grey key tips used to sit and records its
	 * screen-space hit-box for click routing; the tail absorbs truncation so the
	 * buttons stay intact while they fit. The back label gets the same
	 * treatment — colored, bold-on-hover, click-routed — whenever it fully fits. */
	private delegationHeader(
		record: DelegationRecord,
		theme: Theme,
		width: number,
		buttons: boolean,
	): string {
		const statusIcon =
			record.status === "running"
				? theme.fg("warning", `${SPINNER[this.tick % SPINNER.length] ?? "•"} live`)
				: record.status === "done"
					? theme.fg("success", "✓ done")
					: theme.fg("error", "✗ failed");
		const stats = `turn ${record.turns} · ${formatTokens(record.tokensIn)}→${formatTokens(record.tokensOut)} tok${
			record.status !== "running" && record.finishedAt !== undefined
				? ` · ${formatDuration(record.finishedAt - record.startedAt)}`
				: ""
		}`;
		const who = record.handle ? `@${record.handle} (${record.agent})` : record.agent;
		const head = `${theme.bold("torus fleet")} ${theme.fg("dim", "·")} ${theme.fg(entityColor(record.handle ?? record.agent), who)} ${theme.fg("dim", record.model)} ${statusIcon} ${stats}${theme.fg("dim", " · j/k scroll · g/G ends")}`;
		const back = this.hoverButton === "back" ? theme.bold(BACK_LABEL) : BACK_LABEL;
		const tail = `${theme.fg("dim", " · ")}${theme.fg("accent", back)}${theme.fg("dim", ` · ${record.sessionId ?? "no session"}`)}`;
		if (!buttons) {
			this.footerButtons = null;
			const zone = backSpan(visibleWidth(head), width);
			if (zone) this.footerButtons = { y: 0, back: zone };
			return truncateToWidth(head + tail, width);
		}
		const steer = this.hoverButton === "steer" ? theme.bold("[s] steer") : "[s] steer";
		const stop = this.hoverButton === "stop" ? theme.bold("[x] stop") : "[x] stop";
		const mid = `${theme.fg("dim", " · ")}${theme.fg("accent", steer)}${theme.fg("dim", " · ")}${theme.fg("error", stop)}`;
		const lead = head + mid;
		if (visibleWidth(lead) > width) {
			this.footerButtons = null; // buttons clipped — drop the click zones with them
			return truncateToWidth(lead, width);
		}
		const steerStart = visibleWidth(head) + 3; // the dim " · " separator before the button
		const stopStart = steerStart + "[s] steer".length + 3;
		this.footerButtons = {
			y: 0,
			steer: [steerStart, steerStart + "[s] steer".length - 1],
			stop: [stopStart, stopStart + "[x] stop".length - 1],
		};
		const zone = backSpan(visibleWidth(lead), width);
		if (zone) this.footerButtons.back = zone;
		return lead + truncateToWidth(tail, width - visibleWidth(lead));
	}

	private externalHeader(run: ExternalRun, theme: Theme, width: number): string {
		// External runs have no steer/stop controls, but the back label below
		// still gets its colored render and click zone.
		const statusIcon =
			run.state === "running"
				? theme.fg("warning", `${SPINNER[this.tick % SPINNER.length] ?? "•"} live`)
				: run.state === "done"
					? theme.fg("success", "✓ done")
					: theme.fg("error", "✗ failed");
		const stats = `turn ${run.turns ?? 0} · ${formatTokens(run.tokensIn ?? 0)}→${formatTokens(run.tokensOut ?? 0)} tok`;
		const back = this.hoverButton === "back" ? theme.bold(BACK_LABEL) : BACK_LABEL;
		const head = `${theme.bold("torus fleet")} ${theme.fg("dim", "·")} ${theme.fg(entityColor(run.handle ?? run.label), `@${sanitizeRender(run.handle ?? run.label)}`)} ${theme.fg("dim", `[${sanitizeRender(run.source)}]`)} ${run.model ? theme.fg("dim", sanitizeRender(run.model)) : ""} ${statusIcon} ${stats}${theme.fg("dim", " · j/k scroll · g/G ends")}`;
		const tail = `${theme.fg("dim", " · ")}${theme.fg("accent", back)}${theme.fg("dim", ` · ${sanitizeRender(run.sessionId ?? "no session")}`)}`;
		this.footerButtons = null;
		const zone = backSpan(visibleWidth(head), width);
		if (zone) this.footerButtons = { y: 0, back: zone };
		return truncateToWidth(head + tail, width);
	}

	private actionLogLines(logFile: string, theme: Theme, width: number): string[] {
		const body: string[] = [];
		for (const line of liveTail(logFile, 400)) {
			if (line.startsWith("→ ")) {
				body.push(
					`  ${theme.fg("toolTitle", line.slice(0, 2))}${theme.fg("accent", line.slice(2))}`,
				);
			} else if (line.startsWith("← ")) {
				body.push(`  ${theme.fg("dim", line)}`);
			} else if (line.startsWith("~ steer")) {
				body.push(theme.fg("warning", line));
			} else if (
				line.startsWith("--- turn") ||
				line.startsWith("[") ||
				line.startsWith("<torus:")
			) {
				body.push(theme.fg("dim", line));
			} else {
				body.push(truncateToWidth(line, width - 2));
			}
		}
		return body;
	}

	private sessionTranscriptLines(sessionId: string, _theme: Theme, width: number): string[] {
		const body: string[] = [];
		for (const item of transcriptItems(sessionId, 60)) {
			const component = this.componentForItem(sessionId, item);
			// No separator: components carry their own leading spacers, matching the
			// main session's back-to-back chat stacking; tool-only assistant items
			// render zero lines and must not earn a blank either.
			if (component) {
				body.push(...component.render(width));
			}
		}
		return body;
	}

	private delegationDetailBody(record: DelegationRecord, theme: Theme, width: number): string[] {
		if (record.status === "running" && record.sessionId) {
			const lines = this.sessionTranscriptLines(record.sessionId, theme, width);
			if (lines.length > 0) return lines;
		}
		if (record.status !== "running") {
			if (record.sessionId) {
				const lines = this.sessionTranscriptLines(record.sessionId, theme, width);
				if (lines.length > 0) return lines;
			}
		}
		return this.actionLogLines(record.logFile, theme, width);
	}

	private externalDetailBody(run: ExternalRun, theme: Theme, width: number): string[] {
		if (run.sessionId) {
			const lines = this.sessionTranscriptLines(run.sessionId, theme, width);
			if (lines.length > 0) return lines;
		}
		if (run.logFile) return this.actionLogLines(run.logFile, theme, width);
		return [theme.fg("dim", "(no output yet)")];
	}
}

export function registerBrowser(pi: ExtensionAPI): void {
	const openFleet = (ctx: ExtensionContext, focusDelegationId?: string) => {
		// Host as a full-viewport overlay rather than an editor replacement.
		// A rows-tall component in the main content flow pushes its own animated
		// header (and the fleet strip above it) out of the viewport; any change
		// there makes TuiMainScreen clear screen + scrollback and reprint
		// everything (fullRender), which reads as the transcript flickering
		// once per second while a delegation runs. Overlay lines composite into
		// the viewport, so animations stay differential updates.
		ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) =>
				new FleetBrowser(tui, theme, done, focusDelegationId ?? null),
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
			},
		);
	};

	(globalThis as Record<symbol, unknown>)[FLEET_OPENER] = (delegationId?: string) => {
		const hasContent =
			listDelegations().length > 0 || listExternalRuns().some((run) => run.state === "running");
		if (!hasContent) return;
		if (!latestCtx) return;
		openFleet(latestCtx, delegationId);
	};

	let latestCtx: ExtensionContext | null = null;
	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.registerCommand("torus", {
		description: "Browse torus delegations (fleet view: status, outputs, logs)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					listDelegations()
						.map((r) => `${r.status} ${r.agent} t${r.turns}`)
						.join("\n") || "no delegations yet",
					"info",
				);
				return;
			}
			openFleet(ctx);
		},
	});

	pi.registerShortcut("alt+t", {
		description: "Open torus fleet view",
		handler: async (ctx) => {
			const hasContent =
				listDelegations().length > 0 || listExternalRuns().some((run) => run.state === "running");
			if (!ctx.hasUI || !hasContent) return;
			openFleet(ctx);
		},
	});
}

export default function browserExtension(pi: ExtensionAPI): void {
	registerBrowser(pi);
}
