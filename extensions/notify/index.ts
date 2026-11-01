import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, MouseRegion, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { entityColor, flattenPreview, teamName } from "../fleet/theme-kit.js";
import { formatDuration } from "../osnotify.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { FLEET_OPENER, listExternalRuns, sanitizeRender } from "../registry.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux"],
	deps: [{ name: "notify-send", required: true }],
};

type FleetOpener = (delegationId?: string) => void;

function opener(): FleetOpener | undefined {
	return (globalThis as Record<symbol, unknown>)[FLEET_OPENER] as FleetOpener | undefined;
}

function delegationLine(
	icon: string,
	iconColor: Parameters<Theme["fg"]>[0],
	label: string,
	detail: string,
	theme: Theme,
): string {
	return `${theme.fg(iconColor, icon)} ${label}${theme.fg("dim", ` · ${detail}`)}`;
}

/** Single hovered marker across the transcript: a move over one clears the last. */
let hoveredMarker: { hovered: boolean } | null = null;

/**
 * Mouse-region wrapper shared by every delegation surface in the transcript
 * (markers here, the torus_delegate tool block in roster): left-click opens
 * the fleet browser on that delegation (list view when no id), hover bolds.
 */
export function clickable(lines: Component[], delegationId: string | undefined): Component {
	const state = { hovered: false };
	const inner = new (class implements Component {
		render(width: number): string[] {
			return lines
				.flatMap((component) => component.render(width))
				.map((line) => (state.hovered ? `\x1b[1m${line}\x1b[22m` : line));
		}
		invalidate(): void {}
	})();
	return new MouseRegion(inner, (event) => {
		if (event.type === "move") {
			if (hoveredMarker && hoveredMarker !== state) hoveredMarker.hovered = false;
			state.hovered = true;
			hoveredMarker = state;
			return undefined;
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const open = opener();
		if (open) {
			open(delegationId);
			return { handled: true };
		}
		return undefined;
	});
}

/**
 * Per-line click routing for multi-line markers: each logical line carries its
 * own fleet target (id opens that run's detail, null the list, undefined
 * nothing). Lines wrap at the render width, so targets track rendered rows.
 */
export function clickableLines(
	lines: string[],
	targets: Array<string | null | undefined>,
): Component {
	const state = { hovered: false };
	let rowTargets: Array<string | null | undefined> = [];
	const inner = new (class implements Component {
		render(width: number): string[] {
			const rows: string[] = [];
			rowTargets = [];
			for (const [index, line] of lines.entries()) {
				for (const row of wrapTextWithAnsi(line, Math.max(1, width))) {
					rows.push(state.hovered ? `\x1b[1m${row}\x1b[22m` : row);
					rowTargets.push(targets[index]);
				}
			}
			return rows;
		}
		invalidate(): void {}
	})();
	return new MouseRegion(inner, (event) => {
		if (event.type === "move") {
			if (hoveredMarker && hoveredMarker !== state) hoveredMarker.hovered = false;
			state.hovered = true;
			hoveredMarker = state;
			return undefined;
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const target = rowTargets[event.y];
		if (target === undefined) return undefined;
		const open = opener();
		if (!open) return undefined;
		open(target ?? undefined);
		return { handled: true };
	});
}

/** A team-wake line's member resolved to its fleet run id; null opens the list. */
function memberRunTarget(team: string, member: string): string | null {
	const run = listExternalRuns().find(
		(run) => run.handle === member && teamName(run.source) === team,
	);
	return run?.id ?? null;
}

/** Shared by the standalone marker and its wake-batch entry so both surfaces render identically. */
function delegationResultLine(details: Record<string, unknown>, theme: Theme): string {
	const agent = typeof details["agent"] === "string" ? details["agent"] : "?";
	const ok = details["ok"] !== false;
	const stopped = details["stopped"] === true;
	const durationMs = typeof details["durationMs"] === "number" ? details["durationMs"] : null;
	const took = durationMs !== null ? `${formatDuration(durationMs)} · ` : "";
	const runs = typeof details["runs"] === "number" ? details["runs"] : 1;
	const combined = Array.isArray(details["delegationIds"]) && runs > 1;
	const hint = `${took}${combined ? `${runs} runs · ` : ""}alt+t for the ${ok ? "transcript" : "log"}`;
	return delegationLine(
		stopped ? "■" : ok ? "✓" : "✗",
		stopped ? "warning" : ok ? "success" : "error",
		styledRunLabel(details, agent, theme) +
			theme.fg("customMessageText", ` ${stopped ? "stopped" : ok ? "finished" : "failed"}`),
		hint,
		theme,
	);
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	for (const block of message.content) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

/** @handle (or bare agent) in the entity's fleet color — the hue its strip and browser rows carry. */
function styledRunLabel(details: Record<string, unknown>, agent: string, theme: Theme): string {
	const handle = typeof details["handle"] === "string" ? details["handle"] : "";
	if (handle !== "") return theme.fg(entityColor(handle), `@${sanitizeRender(handle)}`);
	return theme.fg(entityColor(agent), agent);
}

export function registerNotify(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("torus.delegation-start", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		const agent = typeof details["agent"] === "string" ? details["agent"] : "?";
		const task = sanitizeRender(
			flattenPreview(textOf(message as { content: Array<{ type: string; text?: string }> }), 70),
		);
		return clickable(
			[
				new Text(
					delegationLine(
						"▶",
						"warning",
						styledRunLabel(details, agent, theme) + theme.fg("customMessageText", " delegated"),
						task,
						theme,
					),
					0,
					0,
				),
			],
			typeof details["delegationId"] === "string" ? details["delegationId"] : undefined,
		);
	});

	pi.registerMessageRenderer("torus.delegation-result", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		return clickable(
			[new Text(delegationResultLine(details, theme), 0, 0)],
			typeof details["delegationId"] === "string" ? details["delegationId"] : undefined,
		);
	});

	pi.registerMessageRenderer("torus.memory-applied", (message, _options, theme) => {
		const text = sanitizeRender(
			flattenPreview(textOf(message as { content: Array<{ type: string; text?: string }> }), 90),
		);
		return clickable(
			[
				new Text(
					delegationLine("✿", "success", theme.fg("customMessageText", "memory"), text, theme),
					0,
					0,
				),
			],
			undefined,
		);
	});

	const monitorLine = (details: Record<string, unknown>, theme: Theme): string => {
		const name = typeof details["name"] === "string" ? sanitizeRender(details["name"]) : "monitor";
		const failed = details["reason"] === "fail";
		const exit = typeof details["exit"] === "number" ? `exit ${details["exit"]}` : "";
		const tail = sanitizeRender(flattenPreview(details["tail"], 70));
		return delegationLine(
			failed ? "✗" : "≈",
			failed ? "error" : "warning",
			theme.fg("customMessageText", `monitor ${name} ${failed ? "failed" : "output changed"}`),
			[exit, tail].filter(Boolean).join(" · "),
			theme,
		);
	};

	pi.registerMessageRenderer("torus.monitor-fired", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		return new Text(monitorLine(details, theme), 0, 0);
	});

	const teamWakeEntries = (
		details: Record<string, unknown>,
		theme: Theme,
	): { lines: string[]; targets: Array<string | null | undefined> } => {
		const team = typeof details["team"] === "string" ? sanitizeRender(details["team"]) : "team";
		const episode = (entry: Record<string, unknown>) => {
			const member = typeof entry["member"] === "string" ? sanitizeRender(entry["member"]) : "?";
			const status = typeof entry["status"] === "string" ? entry["status"] : "idle";
			const reason = sanitizeRender(flattenPreview(entry["reason"], 70));
			return {
				line: delegationLine(
					status === "stopped" ? "✗" : "☾",
					status === "stopped" ? "error" : "warning",
					theme.fg("customMessageText", `team ${team}: `) +
						theme.fg(entityColor(member), `@${member}`) +
						theme.fg("customMessageText", ` ${status}`),
					reason,
					theme,
				),
				// Clicking an episode opens that member's detail; a member with no
				// live run left falls back to the list.
				target: memberRunTarget(team, member),
			};
		};
		const candidates = Array.isArray(details["members"])
			? details["members"].filter(
					(e): e is Record<string, unknown> => typeof e === "object" && e !== null,
				)
			: [details];
		const entries = candidates.length > 0 ? candidates : [details];
		return {
			lines: entries.map((entry) => episode(entry).line),
			targets: entries.map((entry) => episode(entry).target),
		};
	};

	pi.registerMessageRenderer("torus.team-wake", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		const { lines, targets } = teamWakeEntries(details, theme);
		return clickableLines(lines, targets);
	});

	// One batch marker per wake-gate flush; each entry renders with the same
	// lines its standalone marker would have shown, and every line keeps its
	// own click target: a completion opens its run, a member episode that
	// member, monitor lines carry no target.
	pi.registerMessageRenderer("torus.wake-batch", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		const lines: string[] = [];
		const targets: Array<string | null | undefined> = [];
		const entries = Array.isArray(details["entries"]) ? details["entries"] : [];
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) continue;
			const entryDetails = (entry as Record<string, unknown>)["details"];
			if (typeof entryDetails !== "object" || entryDetails === null) continue;
			const customType = (entry as Record<string, unknown>)["customType"];
			if (customType === "torus.team-wake") {
				const wake = teamWakeEntries(entryDetails as Record<string, unknown>, theme);
				lines.push(...wake.lines);
				targets.push(...wake.targets);
			} else if (customType === "torus.monitor-fired") {
				lines.push(monitorLine(entryDetails as Record<string, unknown>, theme));
				targets.push(undefined);
			} else if (customType === "torus.delegation-result") {
				const record = entryDetails as Record<string, unknown>;
				lines.push(delegationResultLine(record, theme));
				targets.push(typeof record["delegationId"] === "string" ? record["delegationId"] : null);
			}
		}
		if (lines.length === 0) {
			lines.push(
				delegationLine(
					"☾",
					"warning",
					theme.fg("customMessageText", "wake batch"),
					sanitizeRender(
						flattenPreview(
							textOf(message as { content: Array<{ type: string; text?: string }> }),
							90,
						),
					),
					theme,
				),
			);
			targets.push(undefined);
		}
		return clickableLines(lines, targets);
	});
}

export default function notifyExtension(pi: ExtensionAPI): void {
	if (!gateExtension("notify", PLATFORM_SUPPORT)) return;
	registerNotify(pi);
}
