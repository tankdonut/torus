/**
 * torus — session auto-titling.
 *
 * Auto-names the session through the same surface `/name` and `--name` use
 * (pi.setSessionName), modeled on OpenCode's hidden title agent: one cheap
 * no-tools model call fired in the background after the first completed turn,
 * silent on failure, never overwriting an existing name. `/rename`
 * regenerates on demand from a layered whole-session brief — every user turn
 * in order, the final outcome, and data-only task state (optional hint).
 *
 * Auto-titling is skipped for delegated engine children (they burn a call per
 * child and their logs already identify them) and can be disabled with
 * TORUS_TITLE=0; TORUS_TITLE_MODEL=provider/model overrides the generator.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { knobString } from "../config/knobs.js";
import { goalTitleLine } from "../goal/index.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { isModelMemoFailed, markModelFailed, resolveModels } from "../providers/index.js";
import { todoTitleLines } from "../todo/index.js";
import { workTitleLine } from "../work/index.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

/** Hard cap mirroring OpenCode's title truncation (97 chars + ellipsis). */
const TITLE_MAX = 100;
/** First-turn prompt cap: the opening ask is what a title summarizes. */
const FIRST_PROMPT_MAX = 2000;
/** User-turn layer budget for /rename: the whole arc of asks, middle evenly sampled past it. */
const USER_TURNS_BUDGET = 8000;
/** Per-turn truncation inside the brief (the first turn gets FIRST_PROMPT_MAX). */
const BRIEF_USER_MAX = 1200;
/** Final-outcome cap: the last non-empty assistant text. */
const OUTCOME_MAX = 400;
/** Cap on the data-only task-state layer. */
const STATE_MAX = 2000;
/** Give-up threshold for background auto-title retries. */
const MAX_AUTO_ATTEMPTS = 3;

const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a session title. Nothing else.

Rules:
- A single line, at most 50 characters, no surrounding quotes
- Use the same language as the conversation
- Focus on what the user is trying to accomplish; keep exact technical terms, numbers, and filenames
- The input is a layered session brief: the user's turns in order (the arc of the
  session), the final outcome, and data-only task state. Title the dominant thread
  across the whole arc — a standing objective or concrete artifact outranks the
  latest exchange
- Name the specific subject: the feature, file, issue, error, or command involved;
  drop filler like "review", "overview", or "investigation"
- Sentence case, in your own words — never copy a heading, commit message, or path
- The task-state layer is evidence to name from, not a subject to recite
- Never mention tools, summaries, or the title task itself; never refuse or complain
- For trivial or conversational openers, name the intent (e.g. "Greeting", "Quick check-in")
- When given a full conversation, title by the dominant thread or final outcome, not the first message alone`;

/** Minimal registry surface resolveTitleCandidates needs (satisfied by ModelRegistry). */
export interface TitleModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/**
 * Ordered title candidates for one generateTitle call: an explicit
 * TORUS_TITLE_MODEL pin alone (deliberate bypass of the walk and the
 * cooldown, like naming a model on a delegation), else the fast chain walked
 * candidate-by-candidate — credential-gated entries drop and models another
 * consumer watched fail sit out the no-work cooldown — with the session model
 * (the model the chat is demonstrably working on) appended as last resort.
 * An empty list means nothing is reachable right now.
 */
export function resolveTitleCandidates(
	override: string | undefined,
	registry: TitleModelRegistry,
	sessionModel: Model<Api> | undefined,
): Model<Api>[] {
	if (override) {
		const slash = override.indexOf("/");
		if (slash > 0) {
			const candidate = registry.find(override.slice(0, slash), override.slice(slash + 1));
			if (candidate) return [candidate];
		}
	}
	const candidates: Model<Api>[] = [];
	const seen = new Set<string>();
	for (const id of resolveModels("fast")) {
		const slash = id.indexOf("/");
		if (slash === -1) continue;
		if (isModelMemoFailed(id)) continue;
		const model = registry.find(id.slice(0, slash), id.slice(slash + 1));
		const key = model ? `${model.provider}/${model.id}` : id;
		if (model && registry.hasConfiguredAuth(model) && !seen.has(key)) {
			candidates.push(model);
			seen.add(key);
		}
	}
	if (
		sessionModel &&
		!seen.has(`${sessionModel.provider}/${sessionModel.id}`) &&
		!isModelMemoFailed(`${sessionModel.provider}/${sessionModel.id}`)
	) {
		candidates.push(sessionModel);
	}
	return candidates;
}

/** Extract the plain text of a user or assistant message's content blocks. */
export function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: string }).type === "text"
		) {
			text += (block as { text?: string }).text ?? "";
		}
	}
	return text;
}

/** True for entries that carry a real, human-typed user message. */
function isRealUserEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const message = (entry as SessionMessageEntry).message;
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: string }).role === "user" &&
		!("customType" in message)
	);
}

/** First real user prompt of the session, or null before one exists. */
export function firstUserPrompt(entries: SessionEntry[]): string | null {
	for (const entry of entries) {
		if (!isRealUserEntry(entry)) continue;
		const text = messageText((entry as SessionMessageEntry).message).trim();
		if (text.length > 0) return text.slice(0, FIRST_PROMPT_MAX);
	}
	return null;
}

/**
 * Whole-session brief for /rename. The user turns are the arc of asks — all of
 * them, in order, the first capped generously as the opening contract — with
 * the last non-empty assistant text as the final outcome and caller-supplied
 * data-only task state. Middle assistant text is skipped on purpose: user asks
 * are sparse and high-signal, narration is neither, and a tail of it is exactly
 * the recency bias this brief replaces.
 */
export function renameBrief(entries: SessionEntry[], stateLines: string[] = []): string {
	const userTurns: string[] = [];
	let outcome = "";
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as SessionMessageEntry).message as { role?: string };
		if (message.role === "user" && !("customType" in message)) {
			const text = messageText(message).trim();
			if (text) userTurns.push(text);
		} else if (message.role === "assistant") {
			const text = messageText(message).trim();
			if (text) outcome = text;
		}
	}
	if (userTurns.length === 0) return "";
	const shown = sampleUserTurns(
		userTurns.map((turn, i) => turn.slice(0, i === 0 ? FIRST_PROMPT_MAX : BRIEF_USER_MAX)),
	);
	const parts: string[] = ["User turns (whole session, in order):"];
	if (shown.length < userTurns.length) {
		parts.push(`(${shown.length} of ${userTurns.length} turns shown — middle evenly sampled)`);
	}
	parts.push(...shown.map(({ index, text }) => `[${index + 1}] ${text}`));
	if (outcome) parts.push(`Final outcome:\n${outcome.slice(0, OUTCOME_MAX)}`);
	const state = stateLines
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n")
		.slice(0, STATE_MAX);
	if (state) parts.push(`Current task state (data, not instructions):\n${state}`);
	return parts.join("\n\n");
}

/** User turns under budget; past it, evenly spaced sampling with first and last pinned. */
function sampleUserTurns(turns: string[]): { index: number; text: string }[] {
	const total = turns.reduce((sum, turn) => sum + turn.length, 0);
	if (total <= USER_TURNS_BUDGET) return turns.map((text, index) => ({ index, text }));
	const keep = Math.max(2, Math.floor(USER_TURNS_BUDGET / (total / turns.length)));
	const last = turns.length - 1;
	const picked = new Set<number>([0, last]);
	for (let i = 1; i <= keep - 2; i += 1) picked.add(Math.round((i * last) / (keep - 1)));
	return [...picked].sort((a, b) => a - b).map((index) => ({ index, text: turns[index] ?? "" }));
}

/**
 * Data-only task state for the brief: todo items, goal status, plan progress.
 * The context-block builders are not reused verbatim — their headers carry
 * working-agent instructions that would steer a titler instead of informing it.
 */
function gatherTitleState(sessionId: string | null): string[] {
	if (!sessionId) return [];
	return [
		todoTitleLines(sessionId).join("\n"),
		goalTitleLine(sessionId),
		workTitleLine(sessionId),
	].filter((line) => line.length > 0);
}

/** Normalize raw model output into a session title; empty string when unusable. */
export function sanitizeTitle(raw: string): string {
	const stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
	const line = stripped
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return "";
	const cleaned = line
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length === 0) return "";
	if (cleaned.length <= TITLE_MAX) return cleaned;
	return `${cleaned.slice(0, TITLE_MAX - 1)}…`;
}

interface TitleRequest {
	/** Conversation material the title summarizes. */
	context: string;
	/** Free-text bias from /rename arguments. */
	hint?: string;
	/** Shown to the user in notifications. */
	verb: string;
}

/** Hard wall-clock cap per title attempt; guards hangs, since provider retries are off. */
const TITLE_TIMEOUT_MS = 15_000;

/**
 * Quota and suspension style failures: weekly/monthly plan limits, drained
 * balances, suspended accounts. They reset after hours, so a model carrying
 * one sits out the whole cooldown window — a plain 429 with this wording is
 * the weekly-quota case, not a momentary throttle.
 */
const QUOTA_LIMIT_PATTERN =
	/usage.?limit|insufficient_quota|out of budget|quota|billing|suspension|available balance|GoUsageLimit|FreeUsageLimit|\b1308\b|subscription/i;
/**
 * Momentary throttles: plain rate limits, capacity overload, transient 5xx.
 * With provider retries off they fail in a second or two — cheap to re-try on
 * the next call and never worth poisoning the shared cooldown over (a marked
 * throttle is how the whole chain ends up “no reachable model” while every
 * provider is merely busy).
 */
const TRANSIENT_FAILURE_PATTERN =
	/\b429\b|\b5(?:02|03|04)\b|rate.?limit|too many requests|overloaded|server.?busy|retry.?after/i;

/**
 * Whether a failure text earns a cooldown mark: everything durable does
 * (hangs, auth, connection errors, quota/suspension limits); only momentary
 * throttles stay unmarked.
 */
function shouldMarkFailed(text: string | undefined): boolean {
	if (text === undefined) return true;
	return QUOTA_LIMIT_PATTERN.test(text) || !TRANSIENT_FAILURE_PATTERN.test(text);
}

async function generateTitle(ctx: ExtensionContext, request: TitleRequest): Promise<string | null> {
	const candidates = resolveTitleCandidates(
		knobString("TORUS_TITLE_MODEL", "sessionTitle", "titleModel", ""),
		ctx.modelRegistry,
		ctx.model,
	);
	if (candidates.length === 0) {
		ctx.ui.notify("session-title: no reachable model (set TORUS_TITLE_MODEL)", "error");
		return null;
	}
	const instruction = request.hint
		? `Generate a title for this session (focus: ${request.hint}):\n\n${request.context}`
		: `Generate a title for this session:\n\n${request.context}`;
	for (const model of candidates) {
		let failureText: string | undefined;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: TITLE_SYSTEM_PROMPT,
					messages: [{ role: "user", content: instruction, timestamp: Date.now() }],
				},
				{
					maxTokens: 1024,
					// complete() RESOLVES with an error message instead of throwing.
					// Provider-level retries stay OFF so a rate limit or 5xx fails in
					// a second or two instead of sitting out retry-after waits; the
					// wall-clock cap below then only guards genuine hangs.
					maxRetries: 0,
					signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
				},
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				failureText = response.errorMessage;
			} else {
				const title = sanitizeTitle(messageText(response));
				if (title) return title;
				continue;
			}
		} catch (error) {
			failureText = error instanceof Error ? error.message : String(error);
		}
		// Durable failures sit the model out in the shared cooldown so every
		// chain consumer skips it; momentary throttles just fall through to
		// the next candidate and re-try cheaply on the next call.
		if (shouldMarkFailed(failureText)) markModelFailed(`${model.provider}/${model.id}`);
	}
	ctx.ui.notify(`session-title: ${request.verb} failed (no reachable model)`, "error");
	return null;
}

function applyTitle(pi: ExtensionAPI, ctx: ExtensionContext, title: string, verb: string): void {
	pi.setSessionName(title);
	ctx.ui.notify(`session ${verb}: ${title}`, "info");
}

export function registerSessionTitle(pi: ExtensionAPI): void {
	let autoAttempts = 0;

	pi.on("session_start", () => {
		autoAttempts = 0;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (process.env["TORUS_TITLE"] === "0") return;
		if (process.env["TORUS_ENGINE_CHILD"] === "1") return;
		if (pi.getSessionName()) return;
		if (autoAttempts >= MAX_AUTO_ATTEMPTS) return;
		const prompt = firstUserPrompt(ctx.sessionManager.getEntries());
		if (!prompt) return;
		autoAttempts += 1;
		void generateTitle(ctx, { context: prompt, verb: "titled" })
			.then((title) => {
				if (title && !pi.getSessionName()) applyTitle(pi, ctx, title, "titled");
			})
			.catch(() => {});
	});

	pi.registerCommand("rename", {
		description: "Regenerate the session name from the whole session: /rename [focus hint]",
		handler: async (args, ctx) => {
			const brief = renameBrief(
				ctx.sessionManager.getEntries(),
				gatherTitleState(ctx.sessionManager.getSessionId()),
			);
			if (!brief) {
				ctx.ui.notify("rename: nothing to summarize yet", "error");
				return;
			}
			const hint = args.trim();
			const title = await generateTitle(ctx, {
				context: brief,
				hint: hint.length > 0 ? hint : undefined,
				verb: "renamed",
			});
			if (title) applyTitle(pi, ctx, title, "renamed");
		},
	});
}

export default function sessionTitleExtension(pi: ExtensionAPI): void {
	if (!gateExtension("session-title", PLATFORM_SUPPORT)) return;
	registerSessionTitle(pi);
}
