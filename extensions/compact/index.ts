/**
 * torus — compaction context folding.
 *
 * The per-turn context blocks (goal, work, todos, memory) keep execution
 * anchored, but compaction replaces the conversation with a summary and the
 * engine offers no way for an extension to mutate that summary's instructions.
 * The only augmentation path is providing the summary itself, so this
 * extension hooks `session_before_compact` and generates one that carries the
 * four blocks through. It is registered last in `pi.extensions` on purpose:
 * handler composition across extensions is last-wins with a swallowed-error
 * fallback, so the last registrant owns the returned compaction. The handler
 * never cancels and never throws — a failed summary call falls back to the
 * engine's default compaction.
 *
 * The extension also paints the live context-usage chip ("ctx NN%" under the
 * torus:ctx statusline key) on session start, at every message end, and after
 * compaction, clearing the segment whenever usage is unavailable.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type CompactionResult,
	type ContextUsage,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { goalContextBlock } from "../goal/index.js";
import { memoryContextBlock } from "../memory/index.js";
import { currentSessionId, setCurrentSessionId } from "../registry.js";
import { todoContextBlock } from "../todo/index.js";
import { workContextBlock } from "../work/index.js";

/** Header above the folded blocks; tests assert on it as the appendix marker. */
const FOLD_HEADER = "Torus session context to carry through the summary:";

/** Minimal event surface the instruction builder needs; the engine event satisfies it. */
export interface FoldInstructionsEvent {
	customInstructions?: string;
}

/**
 * Generates the CompactionResult for a fold. Receives the merged instructions
 * (existing custom instructions first, then the appendix) so injected fakes
 * can assert on exactly what the summary call would see.
 */
export type FoldGenerate = (
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	instructions: string,
) => Promise<CompactionResult> | CompactionResult;

/** The four context blocks that survive compaction, empty ones dropped. */
function foldBlocks(sessionId: string | null): string[] {
	return [
		goalContextBlock(sessionId),
		workContextBlock(sessionId),
		todoContextBlock(sessionId),
		memoryContextBlock(process.cwd(), "", sessionId ?? ""),
	].filter((block) => block.length > 0);
}

/** Existing custom instructions first, then the appendix under its header. */
function joinInstructions(existing: string | undefined, blocks: string[]): string {
	const appendix = [FOLD_HEADER, ...blocks].join("\n\n");
	return existing !== undefined && existing.trim().length > 0
		? `${existing}\n\n${appendix}`
		: appendix;
}

/**
 * Merged summarization instructions for the current session: the event's
 * custom instructions (when set) followed by the four context blocks under
 * one header. Empty string when there is nothing to fold.
 */
export function buildFoldInstructions(event: FoldInstructionsEvent): string {
	const blocks = foldBlocks(currentSessionId());
	if (blocks.length === 0) return "";
	return joinInstructions(event.customInstructions, blocks);
}

function summaryPrompt(
	instructions: string,
	conversationText: string,
	previousSummary?: string,
): string {
	const previous = previousSummary
		? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`
		: "";
	return `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the conversation history, so include all information needed to continue the work effectively. Format the summary as structured markdown with clear sections.

<session-context>
${instructions}
</session-context>

Carry the session context above into the summary so it survives compaction.${previous}

<conversation>
${conversationText}
</conversation>`;
}

/**
 * Default summary generation, following the engine's custom-compaction
 * example: serialize the messages to summarize, ask the session's current
 * model for a structured summary with the folded instructions as focus.
 * Throws on any failure; the hook handler catches and falls back.
 */
async function defaultGenerate(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	instructions: string,
): Promise<CompactionResult> {
	const { preparation, signal } = event;
	const model = ctx.model;
	if (!model) throw new Error("no active model for the compaction summary");
	const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	const conversationText = serializeConversation(convertToLlm(allMessages));
	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: summaryPrompt(instructions, conversationText, preparation.previousSummary),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			maxTokens: 8192,
			signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);
	const summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	if (!summary.trim() || signal.aborted) throw new Error("compaction summary came back empty");
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage: response.usage,
	};
}

/** Minimal context surface the chip needs; the engine context satisfies it. */
export interface ChipContext {
	getContextUsage(): ContextUsage | undefined;
	ui: { setStatus(key: string, text: string | undefined): void };
}

/**
 * Paints the live context-usage statusline chip under the "torus:ctx" key:
 * exactly "ctx NN%" (rounded percentage, no thresholds, colors, or raw token
 * counts), or undefined to clear the segment when usage is unavailable (no
 * active model, or the token estimate is still unknown right after
 * compaction).
 */
export function paintContextChip(ctx: ChipContext): void {
	const usage = ctx.getContextUsage();
	ctx.ui.setStatus(
		"torus:ctx",
		usage && usage.percent !== null ? `ctx ${Math.round(usage.percent)}%` : undefined,
	);
}

/**
 * Registers the fold. Never cancels, never throws: with nothing to fold (all
 * four blocks empty) or on any generation failure, the handler returns
 * undefined and the engine's default compaction runs unchanged.
 */
export function registerCompact(
	pi: ExtensionAPI,
	deps: { generate: FoldGenerate } = { generate: defaultGenerate },
): void {
	pi.on("session_start", (_event, ctx) => {
		setCurrentSessionId(ctx.sessionManager.getSessionId());
		paintContextChip(ctx);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			if (event.signal.aborted) return undefined;
			const blocks = foldBlocks(currentSessionId());
			if (blocks.length === 0) return undefined;
			const instructions = joinInstructions(event.customInstructions, blocks);
			const compaction = await deps.generate(event, ctx, instructions);
			return { compaction };
		} catch {
			return undefined;
		}
	});
	pi.on("message_end", (_event, ctx) => {
		paintContextChip(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		paintContextChip(ctx);
	});
}

export default function compactExtension(pi: ExtensionAPI): void {
	registerCompact(pi);
}
