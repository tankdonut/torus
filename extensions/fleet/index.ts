import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { gateExtension, type PlatformSupport } from "../platform.js";
import {
	type DelegationRecord,
	externalRunAgeSeconds,
	FLEET_OPENER,
	listDelegations,
	listExternalRuns,
	listExternalRunsExcludingDelegations,
	sanitizeRender,
} from "../registry.js";
import {
	delegationIcon,
	entityColor,
	externalRunIcon,
	formatDuration,
	type Theme,
} from "./theme-kit.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
	deps: [{ name: "tmux", required: false, note: "optional delegation panes and fleet views" }],
};

const WIDGET_KEY = "torus-fleet";
const SPINNER_INTERVAL_MS = 80;
/** Agent segments shown before the rest fold into the +N overflow chip. */
const MAX_SEGMENTS = 4;
/** The line's list-open affordance: accent chip, click-routed like the browser footer buttons. */
const ALL_HINT = "alt+t all";
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

/** One clickable piece of the strip line: styled text plus what a click opens. */
interface StripSegment {
	text: string;
	/** Delegation or external-run id; null opens the fleet list. */
	id: string | null;
}

/**
 * The fleet strip as a single pinned line above the input box: an accent
 * `fleet N` count chip, then one compact segment per running entity (slot
 * number, spinner, entity-colored name, age), then a `+N` overflow chip and
 * the accent `alt+t all` affordance. Every chip is click-routed like the
 * browser footer buttons: a segment opens that run's detail, the rest open
 * the list. Detail (model, tokens, cost) lives in the fleet browser.
 */
class FleetStrip implements Component {
	private tui: TUI;
	private theme: Theme;
	private timer: ReturnType<typeof setInterval> | null = null;
	private tick = 0;
	private lastProbe: string | null = null;
	/** Clickable spans of the rendered line: column ranges and their target. */
	private spans: Array<{ start: number; end: number; id: string | null }> = [];
	/** Hovered span index for bold-on-hover; null when the pointer is off-chip. */
	private hoverSpan: number | null = null;

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

	private spanAt(x: number): number | null {
		for (const [index, span] of this.spans.entries()) {
			if (withinSpan(x, [span.start, span.end])) return index;
		}
		return null;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			const next = event.y === 0 ? this.spanAt(event.x) : null;
			if (next !== this.hoverSpan) {
				this.hoverSpan = next;
				this.tui.requestRender();
			}
			return undefined;
		}
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		const span = this.spanAt(event.x);
		if (span === null) return undefined;
		const open = opener();
		if (!open) return undefined;
		open(this.spans[span]?.id ?? undefined);
		return { handled: true };
	}

	render(width: number): string[] {
		const running = stableRunning();
		const external = listExternalRunsExcludingDelegations().filter((r) => r.state === "running");
		if (running.length === 0 && external.length === 0) {
			this.spans = [];
			return [];
		}

		const byId = new Map(listExternalRuns().map((r) => [r.id, r] as const));
		const candidates: StripSegment[] = [];
		for (const [index, record] of running.entries()) {
			const name = record.handle
				? `@${sanitizeRender(record.handle)}`
				: sanitizeRender(record.agent);
			candidates.push({
				text:
					this.theme.fg("dim", `${index + 1} `) +
					delegationIcon(this.theme, record.status, byId.get(record.id), this.tick) +
					" " +
					this.theme.fg(entityColor(record.handle ?? record.agent), name) +
					" " +
					this.theme.fg("dim", formatDuration(Date.now() - record.startedAt)),
				id: record.id,
			});
		}
		for (const run of external) {
			const name = `@${sanitizeRender(run.handle ?? run.label)}`;
			candidates.push({
				text:
					externalRunIcon(this.theme, run, this.tick) +
					" " +
					this.theme.fg(entityColor(run.handle ?? run.label), name) +
					" " +
					this.theme.fg("dim", formatDuration(externalRunAgeSeconds(run) * 1000)),
				id: run.id,
			});
		}

		const sep = this.theme.fg("dim", " · ");
		const countChip = this.theme.fg("accent", this.theme.bold(`fleet ${candidates.length}`));
		const allHint = this.theme.fg("accent", ALL_HINT);
		// The count chip and the all-hint are permanent; agent segments fill the
		// remaining width, newest-dropped-first, and everything that no longer
		// fits folds into the +N overflow chip.
		const lineFits = (segments: StripSegment[], overflow: number): boolean => {
			let used = visibleWidth(countChip) + visibleWidth(sep) + visibleWidth(allHint);
			for (const segment of segments) used += visibleWidth(sep) + visibleWidth(segment.text);
			if (overflow > 0) used += visibleWidth(sep) + visibleWidth(`+${overflow}`);
			return used <= width;
		};
		let shown = candidates.slice(0, MAX_SEGMENTS);
		let hidden = candidates.length - shown.length;
		while (!lineFits(shown, hidden) && shown.length > 0) {
			shown = shown.slice(0, -1);
			hidden += 1;
		}

		const pieces: StripSegment[] = [{ text: countChip, id: null }, ...shown];
		if (hidden > 0) pieces.push({ text: this.theme.fg("dim", `+${hidden}`), id: null });
		pieces.push({ text: allHint, id: null });

		let line = "";
		let column = 0;
		this.spans = [];
		for (const [index, piece] of pieces.entries()) {
			if (line !== "") {
				line += sep;
				column += visibleWidth(sep);
			}
			const start = column;
			line += this.hoverSpan === index ? this.theme.bold(piece.text) : piece.text;
			column += visibleWidth(piece.text);
			this.spans.push({ start, end: column - 1, id: piece.id });
		}
		return [line];
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
	if (!gateExtension("fleet", PLATFORM_SUPPORT)) return;
	registerFleetWidget(pi);
}

function withinSpan(x: number, span: readonly [number, number]): boolean {
	return x >= span[0] && x <= span[1];
}
