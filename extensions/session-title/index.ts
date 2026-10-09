/**
 * torus — session auto-titling.
 *
 * Auto-names the session through the same surface `/name` and `--name` use
 * (pi.setSessionName), modeled on OpenCode's hidden title agent: one cheap
 * no-tools model call fired in the background after the first completed turn,
 * silent on failure, never overwriting an existing name. `/rename`
 * regenerates on demand from the whole session transcript (optional hint).
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
import { modelChain } from "../providers/index.js";

/** Hard cap mirroring OpenCode's title truncation (97 chars + ellipsis). */
const TITLE_MAX = 100;
/** First-turn prompt cap: the opening ask is what a title summarizes. */
const FIRST_PROMPT_MAX = 2000;
/** Whole-session digest budget for /rename, split head-heavy. */
const DIGEST_HEAD = 2000;
const DIGEST_TAIL = 4000;
/** Per-message truncation inside the digest. */
const DIGEST_USER_MAX = 1200;
const DIGEST_ASSISTANT_MAX = 300;
/** Give-up threshold for background auto-title retries. */
const MAX_AUTO_ATTEMPTS = 3;
/** Hard fallback when the fast chain resolves empty (it never does today). */
const DEFAULT_TITLE_MODEL = "zai/glm-5.3-flash";

const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a session title. Nothing else.

Rules:
- A single line, at most 50 characters, no surrounding quotes
- Use the same language as the conversation
- Focus on what the user is trying to accomplish; keep exact technical terms, numbers, and filenames
- Never mention tools, summaries, or the title task itself; never refuse or complain
- For trivial or conversational openers, name the intent (e.g. "Greeting", "Quick check-in")
- When given a full conversation, title by the dominant thread or final outcome, not the first message alone`;

/** Minimal registry surface resolveTitleModel needs (satisfied by ModelRegistry). */
export interface TitleModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/** Model cascade for title generation: env override -> fast chain head -> session model. */
export function resolveTitleModel(
	override: string | undefined,
	registry: TitleModelRegistry,
	sessionModel: Model<Api> | undefined,
): Model<Api> | undefined {
	if (override) {
		const slash = override.indexOf("/");
		if (slash > 0) {
			const candidate = registry.find(override.slice(0, slash), override.slice(slash + 1));
			if (candidate) return candidate;
		}
	}
	// The fast chain is read per call, so a chains.json fast override retargets
	// ambient titling without a restart; an unfindable head falls through to the
	// session model below.
	const [provider, modelId] = (modelChain("fast")[0] ?? DEFAULT_TITLE_MODEL).split("/");
	const fast = registry.find(provider ?? "", modelId ?? "");
	if (fast && registry.hasConfiguredAuth(fast)) return fast;
	return sessionModel;
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
 * Whole-session digest for /rename: interleaved user asks and assistant
 * answers, tool noise skipped, head+tail capped so long sessions keep both
 * the original ask and the latest outcome.
 */
export function sessionDigest(entries: SessionEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as SessionMessageEntry).message as { role?: string };
		if (message.role === "user" && !("customType" in message)) {
			const text = messageText(message).trim();
			if (text) lines.push(`User: ${text.slice(0, DIGEST_USER_MAX)}`);
		} else if (message.role === "assistant") {
			const text = messageText(message).trim();
			if (text) lines.push(`Assistant: ${text.slice(0, DIGEST_ASSISTANT_MAX)}`);
		}
	}
	if (lines.length === 0) return "";
	const whole = lines.join("\n");
	if (whole.length <= DIGEST_HEAD + DIGEST_TAIL) return whole;
	return `${whole.slice(0, DIGEST_HEAD)}\n[…truncated…]\n${whole.slice(-DIGEST_TAIL)}`;
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

async function generateTitle(ctx: ExtensionContext, request: TitleRequest): Promise<string | null> {
	const model = resolveTitleModel(process.env["TORUS_TITLE_MODEL"], ctx.modelRegistry, ctx.model);
	if (!model) {
		ctx.ui.notify("session-title: no model available (set TORUS_TITLE_MODEL)", "error");
		return null;
	}
	const instruction = request.hint
		? `Generate a title for this conversation (focus: ${request.hint}):\n\n${request.context}`
		: `Generate a title for this conversation:\n\n${request.context}`;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: instruction, timestamp: Date.now() }],
			},
			{ maxTokens: 1024 },
		);
		return sanitizeTitle(messageText(response));
	} catch {
		ctx.ui.notify(`session-title: ${request.verb} failed (model unreachable)`, "error");
		return null;
	}
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
			if (ctx.isIdle() === false) {
				ctx.ui.notify("rename: wait for the current turn to finish", "error");
				return;
			}
			const digest = sessionDigest(ctx.sessionManager.getEntries());
			if (!digest) {
				ctx.ui.notify("rename: nothing to summarize yet", "error");
				return;
			}
			const hint = args.trim();
			const title = await generateTitle(ctx, {
				context: digest,
				hint: hint.length > 0 ? hint : undefined,
				verb: "renamed",
			});
			if (title) applyTitle(pi, ctx, title, "renamed");
		},
	});
}

export default function sessionTitleExtension(pi: ExtensionAPI): void {
	registerSessionTitle(pi);
}
