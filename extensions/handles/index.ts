/**
 * The @-mention surface: handles were labels for fleet views and pane titles;
 * this extension turns them into addresses. Typing `@handle <message>` in the
 * main input box steers the named running delegation or queues mail for the
 * named team member, and the editor's tab completion offers every live target
 * next to the built-in `@path` file suggestions. In rendered prose (assistant
 * and user messages) live `@handle` tokens carry the same per-entity color
 * the fleet views use.
 *
 * Routing rules:
 * - Running delegations steer through the registry control (the same path the
 *   fleet browser's `s` key uses); a run without a live control reports that.
 * - Team members (and member registry records, id `<team>/<name>`) route to
 *   the mailbox instead: the supervisor polls the inbox every few seconds and
 *   never lets a second prompt stream race its own, so mail is the only
 *   sanctioned member steer path.
 * - A mention that matches nothing falls through to the normal prompt, so
 *   `@file.md` attachments keep working untouched.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { entityColor } from "../fleet/theme-kit.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { listDelegations, listTeams, steerDelegation } from "../registry.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
};

/** One addressable target behind an `@name` mention. */
export type MentionTarget =
	| {
			kind: "run";
			name: string;
			delegationId: string;
			agent: string;
			turns: number;
	  }
	| {
			kind: "member";
			name: string;
			teamId: string;
			teamName: string;
			agent: string;
			memberStatus: string;
	  };

/**
 * Live @-mention targets: running delegations by handle plus active team
 * members by name. Member registry records carry the `<team>/<name>` id shape
 * and are skipped in the delegation pass so each member has exactly one
 * mention route (the mailbox).
 */
export function liveMentionTargets(): MentionTarget[] {
	const targets: MentionTarget[] = [];
	for (const record of listDelegations()) {
		if (record.status !== "running" || !record.handle) continue;
		if (record.id.includes("/")) continue;
		targets.push({
			kind: "run",
			name: record.handle,
			delegationId: record.id,
			agent: record.agent,
			turns: record.turns,
		});
	}
	for (const team of listTeams()) {
		if (team.status !== "active") continue;
		for (const member of team.members) {
			if (member.status === "stopped") continue;
			targets.push({
				kind: "member",
				name: member.name,
				teamId: team.id,
				teamName: team.name,
				agent: member.agent,
				memberStatus: member.status,
			});
		}
	}
	return targets;
}

/** Exact-name matches across both target kinds; handles more than one when names collide. */
export function resolveMention(name: string): MentionTarget[] {
	const wanted = name.toLowerCase();
	return liveMentionTargets().filter((target) => target.name.toLowerCase() === wanted);
}

/** One-line target description for notifications and completion menus. */
export function describeTarget(target: MentionTarget): string {
	return target.kind === "run"
		? `@${target.name} · ${target.agent} run · turn ${target.turns}`
		: `@${target.name} · ${target.agent} · team ${target.teamName} · ${target.memberStatus}`;
}

/** A parsed mention line: `@name` plus everything after it, when present. */
export interface MentionCommand {
	name: string;
	message: string | null;
}

/**
 * Parse a mention at the very start of the input. The name charset matches
 * what normalizeHandle and team member names produce (`[a-z0-9-]`), so a
 * `@file.md` or `@src/foo` attachment never parses as a mention.
 */
export function parseMentionInput(text: string): MentionCommand | null {
	const match = /^@([A-Za-z0-9-]+)(?:[ \t]+([\s\S]*))?$/.exec(text);
	const [, name, rest] = match ?? [];
	if (name === undefined) return null;
	const message = (rest ?? "").trim();
	return { name, message: message.length > 0 ? message : null };
}

/** Routing outcome: fall through to the normal prompt, or consume the input with feedback. */
export type MentionRouteResult =
	| { action: "continue" }
	| { action: "handled"; notify: { text: string; level: "info" | "error" } };

/**
 * Deliver a parsed mention to its target. Pure routing plus the same side
 * channels the fleet browser uses (registry steer control, member inbox), so
 * tests drive it without a live session. The mailbox write lazily imports
 * team-runtime: that module graph is heavy, and mail is the rare route, so
 * the session's cold start never pays for it.
 */
export async function routeMention(command: MentionCommand): Promise<MentionRouteResult> {
	const targets = resolveMention(command.name);
	if (targets.length === 0) return { action: "continue" };
	if (targets.length > 1) {
		const list = targets.map(describeTarget).join("; ");
		return {
			action: "handled",
			notify: {
				text: `@${command.name} matches more than one target (${list}); steer by a unique handle`,
				level: "error",
			},
		};
	}
	const target = targets[0];
	if (!target) return { action: "continue" };
	if (command.message === null) {
		return { action: "handled", notify: { text: describeTarget(target), level: "info" } };
	}
	if (target.kind === "run") {
		const delivered = steerDelegation(target.delegationId, command.message);
		return {
			action: "handled",
			notify: {
				text: delivered
					? `steered ${describeTarget(target)}`
					: `@${target.name} is not accepting input right now (run settling or between turns); retry mid-turn`,
				level: delivered ? "info" : "error",
			},
		};
	}
	const { deliverMail } = await import("../team-runtime.js");
	deliverMail(target.teamId, target.name, "lead", command.message);
	return {
		action: "handled",
		notify: {
			text: `mail queued for ${describeTarget(target)}; the member reads it within seconds`,
			level: "info",
		},
	};
}

/** Extract the `@token` the cursor sits in. The boundary set mirrors the engine's autocomplete token start, so mid-prose mentions complete too. */
export function mentionTokenAt(textBeforeCursor: string): string | null {
	const match = /(?:^|[\s([{:<`])@([A-Za-z0-9-]*)$/.exec(textBeforeCursor);
	return match ? `@${match[1]}` : null;
}

export function mentionItem(target: MentionTarget): AutocompleteItem {
	return {
		value: `@${target.name}`,
		label: `@${target.name}`,
		description:
			target.kind === "run"
				? `steer · ${target.agent} run · turn ${target.turns}`
				: `mail · ${target.agent} · team ${target.teamName} · ${target.memberStatus}`,
	};
}

const MAX_MENTION_SUGGESTIONS = 8;

/**
 * Names confirmed live at least once this process. Coloring keeps them after
 * their run finishes so a session's mention colors never flip mid-render;
 * bounded by the distinct handles a session ever sees.
 */
const coloredNames = new Set<string>();

/** Test seam: forget every remembered mention name. */
export function resetColoredNamesForTesting(): void {
	coloredNames.clear();
}

/** Names eligible for coloring right now: live targets plus remembered ones. */
function paintableNames(getTargets: () => MentionTarget[]): Set<string> {
	const live = getTargets();
	for (const target of live) coloredNames.add(target.name);
	return coloredNames;
}

const PROSE_MENTION = /(^|[^A-Za-z0-9_@`])@([A-Za-z0-9-]{1,24})(?![A-Za-z0-9-])/g;

/**
 * Color every `@name` mention in `markdown` by calling `paint(name)` for each
 * paintable name. Fenced code blocks are skipped wholesale; a mention glued
 * to a backtick (inline code) keeps its plain text. Pure string work, so
 * tests drive it without a renderer.
 */
export function colorizeMentions(
	markdown: string,
	paint: (name: string) => string,
	getTargets: () => MentionTarget[] = liveMentionTargets,
): string {
	const names = paintableNames(getTargets);
	if (names.size === 0) return markdown;

	// Split on fence delimiters: even chunks are prose, odd chunks are fenced
	// code (an unclosed trailing fence still lands in an odd chunk).
	const chunks = markdown.split(/```/);
	for (let index = 0; index < chunks.length; index += 2) {
		const chunk = chunks[index];
		if (chunk === undefined) continue;
		chunks[index] = chunk.replace(
			PROSE_MENTION,
			(_match: string, boundary: string, name: string) =>
				names.has(name) ? `${boundary}${paint(name)}` : `${boundary}@${name}`,
		);
	}
	return chunks.join("```");
}

/** The active session's theme, stashed on a Symbol.for slot so the markdown transformer (no theme argument) can style mentions. */
const THEME_SLOT = Symbol.for("torus.handles.theme.v1");

type PainterTheme = ExtensionContext["ui"]["theme"];

function stashedTheme(): PainterTheme | undefined {
	return (globalThis as Record<symbol, unknown>)[THEME_SLOT] as PainterTheme | undefined;
}

/**
 * Register the markdown painter: assistant and user prose get `@handle`
 * tokens in the same per-entity color the fleet views use; thinking stays
 * dim, and before the first session_start there is no theme to paint with.
 */
export function registerMentionColoring(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "assistant-thinking") return markdown;
		const theme = stashedTheme();
		if (!theme) return markdown;
		return colorizeMentions(markdown, (name) => theme.fg(entityColor(name), `@${name}`));
	});
}

/**
 * Wrap the editor's autocomplete provider: while the cursor sits in an
 * `@token`, matching live targets are offered ahead of the built-in file
 * suggestions; everything else (paths, slash commands, no live targets)
 * passes through to the wrapped provider untouched.
 */
export function createHandlesAutocompleteProvider(
	current: AutocompleteProvider,
	getTargets: () => MentionTarget[] = liveMentionTargets,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const token = mentionTokenAt(line.slice(0, cursorCol));
			if (token === null) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const query = token.slice(1).toLowerCase();
			const matches = fuzzyFilter(getTargets(), query, (target) => `${target.name} ${target.agent}`)
				.filter((target) => target.name.toLowerCase().startsWith(query) || query === "")
				.slice(0, MAX_MENTION_SUGGESTIONS);
			if (matches.length === 0)
				return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const items = matches.map(mentionItem);
			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (base === null) return { items, prefix: token };
			return { items: [...items, ...base.items], prefix: base.prefix };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function registerHandles(pi: ExtensionAPI): void {
	pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
		// Programmatic sends (extensions, codemode) must not be hijacked.
		if (event.source === "extension") return;
		const command = parseMentionInput(event.text);
		if (!command) return;
		const result = await routeMention(command);
		if (result.action === "continue") return;
		ctx.ui.notify(result.notify.text, result.notify.level);
		const handled: InputEventResult = { action: "handled" };
		return handled;
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		(globalThis as Record<symbol, unknown>)[THEME_SLOT] = ctx.ui.theme;
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => createHandlesAutocompleteProvider(current));
	});

	registerMentionColoring(pi);
}

export default function handlesExtension(pi: ExtensionAPI): void {
	if (!gateExtension("handles", PLATFORM_SUPPORT)) return;
	registerHandles(pi);
}
