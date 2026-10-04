import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type DelegationRecord,
	type ExternalRun,
	externalRunAgeSeconds,
	FLEET_OPENER,
	listDelegations,
	listExternalRuns,
	listExternalRunsExcludingDelegations,
	sanitizeRender,
} from "../registry.js";
import {
	entityColor,
	formatTokens,
	rule,
	SPINNER,
	shortModel,
	statusIcon,
	type Theme,
} from "./theme-kit.js";

const WIDGET_KEY = "torus-fleet";
const SPINNER_INTERVAL_MS = 80;
const MAX_ROWS = 5;
const SLOT_KEYS = [
	"alt+1",
	"alt+2",
	"alt+3",
	"alt+4",
	"alt+5",
	"alt+6",
	"alt+7",
	"alt+8",
	"alt+9",
] as const;

type FleetOpener = (delegationId?: string) => void;

function opener(): FleetOpener | undefined {
	return (globalThis as Record<symbol, unknown>)[FLEET_OPENER] as FleetOpener | undefined;
}

/**
 * Oldest running delegation first: an agent keeps its strip number (and its
 * alt+N binding) for as long as it runs — newest-first would reshuffle rows
 * every time a new delegation spawns.
 */
function stableRunning(): DelegationRecord[] {
	return listDelegations()
		.filter((record) => record.status === "running")
		.sort((a, b) => a.startedAt - b.startedAt);
}

function shortTeamName(source: string): string {
	const teamId = source.slice("torus-team:".length);
	return teamId.replace(/-[a-z0-9]+$/, "");
}

function formatRow(
	record: DelegationRecord,
	theme: Theme,
	tick: number,
	width: number,
	slot: number,
	run?: ExternalRun,
): string {
	const color = entityColor(record.handle ?? record.agent);
	const prefix = theme.fg("dim", `${slot}`);
	const name = theme.fg(
		color,
		record.handle ? `@${sanitizeRender(record.handle)}` : sanitizeRender(record.agent),
	);
	const model = theme.fg("dim", sanitizeRender(shortModel(record.model)));
	const badge =
		run?.source.startsWith("torus-team:") === true
			? ` ${theme.fg("dim", `⧉${sanitizeRender(shortTeamName(run.source))}`)}`
			: "";
	const icon =
		record.status === "running" && run?.memberStatus === "idle"
			? theme.fg("dim", "·")
			: statusIcon(theme, record.status, tick);

	if (record.status === "running") {
		const stats =
			run?.memberStatus === "idle"
				? theme.fg("dim", `t${record.turns} · idle ${Math.round(externalRunAgeSeconds(run))}s`)
				: theme.fg(
						"dim",
						`t${record.turns} · ${formatTokens(record.tokensOut)}o · ${Math.round((Date.now() - record.startedAt) / 1000)}s`,
					);
		return truncateToWidth(`${prefix} ${icon} ${name} ${badge} ${model} ${stats}`, width);
	}
	const stats = theme.fg("dim", `${record.turns}t · ${formatTokens(record.tokensOut)}o`);
	return truncateToWidth(`${prefix} ${icon} ${name} ${badge} ${model} ${stats}`, width);
}

class FleetStrip implements Component {
	private tui: TUI;
	private theme: Theme;
	private timer: ReturnType<typeof setInterval> | null = null;
	private tick = 0;
	private lastProbe: string | null = null;
	/** Per rendered row: delegation id, or null for an external-run row. */
	private rowTargets: Array<string | null> = [];
	/** Hovered row index for bold-on-hover; null when the pointer is off-row. */
	private hoverIndex: number | null = null;

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
		this.timer = setInterval(() => {
			this.tick += 1;
			const probe = this.render(200).join("\n");
			if (probe === this.lastProbe) return;
			this.lastProbe = probe;
			this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			const index = event.y - 2;
			const next = index >= 0 && index < this.rowTargets.length ? index : null;
			if (next !== this.hoverIndex) {
				this.hoverIndex = next;
				this.tui.requestRender();
			}
			return undefined;
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		// Layout is [rule, header, ...rows, rule, ""] — rows start at y=2.
		const target = this.rowTargets[event.y - 2];
		if (target === undefined) return undefined;
		const open = opener();
		if (!open) return undefined;
		// null (external run) opens the plain list; a stale id falls back to it too.
		open(target ?? undefined);
		return { handled: true };
	}

	render(width: number): string[] {
		const running = stableRunning();
		const external = listExternalRunsExcludingDelegations().filter((r) => r.state === "running");
		if (running.length === 0 && external.length === 0) {
			this.rowTargets = [];
			return [];
		}

		const rows: string[] = [];
		const targets: Array<string | null> = [];
		const byId = new Map(listExternalRuns().map((r) => [r.id, r] as const));
		const shownRunning = Math.min(running.length, MAX_ROWS);
		for (const [index, record] of running.slice(0, MAX_ROWS).entries()) {
			rows.push(formatRow(record, this.theme, this.tick, width, index + 1, byId.get(record.id)));
			targets.push(record.id);
		}
		const shownExternal = external.slice(0, Math.max(0, MAX_ROWS - shownRunning));
		for (const run of shownExternal) {
			const age = externalRunAgeSeconds(run);
			const stats = this.theme.fg(
				"dim",
				`t${run.turns ?? 0} · ${formatTokens(run.tokensOut ?? 0)}o · ${age}s`,
			);
			const who = this.theme.fg(
				entityColor(run.handle ?? run.label),
				`@${sanitizeRender(run.handle ?? run.label)}`,
			);
			const model = run.model ? this.theme.fg("dim", sanitizeRender(shortModel(run.model))) : "";
			const icon =
				run.memberStatus === "idle"
					? this.theme.fg("dim", "·")
					: this.theme.fg("warning", SPINNER[this.tick % SPINNER.length] ?? "•");
			rows.push(truncateToWidth(`${icon} ${who} ${model} ${stats}`, width));
			targets.push(null);
		}
		const hidden = running.length + external.length - shownRunning - shownExternal.length;
		if (hidden > 0) {
			rows.push(this.theme.fg("dim", `+${hidden} more · alt+t all`));
			targets.push(null);
		}
		const hoveredRows =
			this.hoverIndex !== null && this.hoverIndex < rows.length
				? rows.map((line, i) => (i === this.hoverIndex ? this.theme.bold(line) : line))
				: rows;
		this.rowTargets = targets;

		const mouse = this.tui.mode === "fullscreen";
		const slots = Math.min(shownRunning, MAX_ROWS, SLOT_KEYS.length);
		const access: string[] = [];
		if (slots > 0) access.push(mouse ? `click/alt+1..${slots}` : `alt+1..${slots}`);
		else if (mouse) access.push("click");
		access.push("alt+t all");
		const header = this.theme.fg(
			"dim",
			`torus fleet — ${shownRunning} running${shownExternal.length > 0 ? ` · ${shownExternal.length} external` : ""}${hidden > 0 ? ` · +${hidden} more` : ""} · ${access.join(" · ")}`,
		);
		const frameRule = rule(this.theme, Math.max(0, width));
		return [frameRule, header, ...hoveredRows, frameRule, ""];
	}
}

export function registerFleetWidget(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new FleetStrip(tui, theme));
	});
	for (const [index, key] of SLOT_KEYS.entries()) {
		pi.registerShortcut(key, {
			description: `Open torus fleet detail on running agent ${index + 1}`,
			handler: async (ctx) => {
				if (!ctx.hasUI) return;
				const record = stableRunning()[index];
				if (!record) return;
				opener()?.(record.id);
			},
		});
	}
}

export default function fleetExtension(pi: ExtensionAPI): void {
	registerFleetWidget(pi);
}
