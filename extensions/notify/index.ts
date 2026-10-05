import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, MouseRegion, Text } from "@earendil-works/pi-tui";
import { flattenPreview } from "../fleet/theme-kit.js";
import { formatDuration } from "../osnotify.js";
import { FLEET_OPENER, sanitizeRender } from "../registry.js";

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
	return (
		theme.fg(iconColor, icon) +
		" " +
		theme.fg("customMessageText", label) +
		theme.fg("dim", ` · ${detail}`)
	);
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

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	for (const block of message.content) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

function runLabel(details: Record<string, unknown>, agent: string): string {
	const handle = typeof details["handle"] === "string" ? details["handle"] : "";
	return handle ? `@${sanitizeRender(handle)}` : agent;
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
					delegationLine("▶", "warning", `${runLabel(details, agent)} delegated`, task, theme),
					0,
					0,
				),
			],
			typeof details["delegationId"] === "string" ? details["delegationId"] : undefined,
		);
	});

	pi.registerMessageRenderer("torus.delegation-result", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		const agent = typeof details["agent"] === "string" ? details["agent"] : "?";
		const ok = details["ok"] !== false;
		const durationMs = typeof details["durationMs"] === "number" ? details["durationMs"] : null;
		const took = durationMs !== null ? `${formatDuration(durationMs)} · ` : "";
		const runs = typeof details["runs"] === "number" ? details["runs"] : 1;
		const combined = Array.isArray(details["delegationIds"]) && runs > 1;
		const hint = `${took}${combined ? `${runs} runs · ` : ""}alt+t for the ${ok ? "transcript" : "log"}`;
		return clickable(
			[
				new Text(
					delegationLine(
						ok ? "✓" : "✗",
						ok ? "success" : "error",
						`${runLabel(details, agent)} ${ok ? "finished" : "failed"}`,
						hint,
						theme,
					),
					0,
					0,
				),
			],
			typeof details["delegationId"] === "string" ? details["delegationId"] : undefined,
		);
	});

	pi.registerMessageRenderer("torus.memory-applied", (message, _options, theme) => {
		const text = sanitizeRender(
			flattenPreview(textOf(message as { content: Array<{ type: string; text?: string }> }), 90),
		);
		return clickable(
			[new Text(delegationLine("✿", "success", "memory", text, theme), 0, 0)],
			undefined,
		);
	});

	pi.registerMessageRenderer("torus.monitor-fired", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		const name = typeof details["name"] === "string" ? sanitizeRender(details["name"]) : "monitor";
		const failed = details["reason"] === "fail";
		const exit = typeof details["exit"] === "number" ? `exit ${details["exit"]}` : "";
		const tail = sanitizeRender(flattenPreview(details["tail"], 70));
		return new Text(
			delegationLine(
				failed ? "✗" : "≈",
				failed ? "error" : "warning",
				`monitor ${name} ${failed ? "failed" : "output changed"}`,
				[exit, tail].filter(Boolean).join(" · "),
				theme,
			),
			0,
			0,
		);
	});

	pi.registerMessageRenderer("torus.team-wake", (message, _options, theme) => {
		const details = (message.details ?? {}) as Record<string, unknown>;
		const team = typeof details["team"] === "string" ? sanitizeRender(details["team"]) : "team";
		const member = typeof details["member"] === "string" ? sanitizeRender(details["member"]) : "?";
		const status = typeof details["status"] === "string" ? details["status"] : "idle";
		const reason = sanitizeRender(flattenPreview(details["reason"], 70));
		return new Text(
			delegationLine(
				status === "stopped" ? "✗" : "☾",
				status === "stopped" ? "error" : "warning",
				`team ${team}: @${member} ${status}`,
				reason,
				theme,
			),
			0,
			0,
		);
	});
}

export default function notifyExtension(pi: ExtensionAPI): void {
	registerNotify(pi);
}
