/**
 * torus — torus_ask.
 *
 * Structured questions for the model with a full-keyboard dialog: options
 * (digits, arrows/j/k), an always-present Custom… free-text row, an
 * always-present "Chat more about this" row, `n` notes attached to the
 * highlighted option, and optional per-option `preview` panes (ASCII
 * mockups, snippets, diagrams). Non-TUI contexts fall back to plain
 * select/input dialogs with the same appended rows; headless contexts get
 * a decide-yourself fallback. Never offer your own "Other"/"custom"/
 * "discuss" options — the dialog appends them.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AskDialog, type AskDialogResult, CHAT_LABEL, CUSTOM_LABEL } from "./dialog.js";

interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

interface AskQuestion {
	question: string;
	header: string;
	options: AskOption[];
}

interface QuestionOutcome {
	answer?: { header: string; text: string };
	chat?: { header: string; question: string };
	unanswered?: string;
}

const askTool = defineTool({
	name: "torus_ask",
	label: "Torus Ask",
	description:
		'Ask the user structured questions with labeled options (interactive select dialog). The dialog ALWAYS appends a free-text "Custom…" row and a "Chat more about this" row, so never include your own "Other"/"custom"/"discuss" options. Options may carry a short description and a monospace preview (ASCII mockup, code snippet, diagram) shown beside the list when highlighted — use previews to compare layouts or code side by side. If you recommend an option, put it first and suffix the label with "(Recommended)". Use for scope decisions, destructive-action confirmation, or missing critical information. In non-interactive contexts the tool returns the options so you can decide and note the choice.',
	parameters: Type.Object({
		questions: Type.Array(
			Type.Object({
				question: Type.String(),
				header: Type.String({ description: "Very short label (max 30 chars)" }),
				options: Type.Array(
					Type.Object({
						label: Type.String(),
						description: Type.Optional(Type.String()),
						preview: Type.Optional(
							Type.String({
								description:
									"Monospace preview shown beside the options when highlighted: ASCII mockup, code snippet, or diagram",
							}),
						),
					}),
					{
						minItems: 2,
						maxItems: 6,
					},
				),
			}),
			{ minItems: 1, maxItems: 4 },
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const outcomes: QuestionOutcome[] = [];

		for (const item of params.questions) {
			if (ctx.mode === "tui") {
				const result = await ctx.ui.custom<AskDialogResult>(
					(tui, theme, _keybindings, done) =>
						new AskDialog(tui, theme, done, {
							header: `${item.header} — ${item.question}`,
							question: item.question,
							options: item.options,
						}),
					{ overlay: true },
				);
				outcomes.push(outcomeFromDialog(item, result));
				continue;
			}

			if (!ctx.hasUI) {
				outcomes.push({
					unanswered: unansweredText(
						item,
						item.options.map((o) => o.label),
					),
				});
				continue;
			}

			const labels = [...item.options.map((o) => o.label), CUSTOM_LABEL, CHAT_LABEL];
			const chosen = await ctx.ui.select(`${item.header} — ${item.question}`, labels);
			if (chosen === CHAT_LABEL) {
				outcomes.push({ chat: { header: item.header, question: item.question } });
			} else if (chosen === CUSTOM_LABEL) {
				const typed = (await ctx.ui.input(`${item.header} — custom answer`))?.trim();
				outcomes.push(
					typed
						? { answer: { header: item.header, text: `${typed} (custom)` } }
						: { unanswered: unansweredText(item, labels) },
				);
			} else if (chosen === undefined) {
				outcomes.push({
					unanswered: unansweredText(
						item,
						item.options.map((o) => o.label),
					),
				});
			} else {
				outcomes.push({ answer: { header: item.header, text: chosen } });
			}
		}

		const answers = outcomes.flatMap((o) => (o.answer ? [o.answer] : []));
		const chats = outcomes.flatMap((o) => (o.chat ? [o.chat] : []));
		const unanswered = outcomes.flatMap((o) => (o.unanswered ? [o.unanswered] : []));

		if (chats.length > 0) {
			const lines = [
				"user chose to discuss before answering — do NOT treat this as approval or a decision:",
				...chats.map((c) => `- ${c.header}: ${c.question}`),
				"",
				"Converse with the user in plain chat about the open questions, then re-call torus_ask once the direction is settled.",
				...(answers.length > 0
					? ["", "already answered:", ...answers.map((a) => `- ${a.header}: ${a.text}`)]
					: []),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "chat" } };
		}

		if (answers.length > 0 && unanswered.length === 0) {
			return {
				content: [{ type: "text", text: answers.map((a) => `${a.header}: ${a.text}`).join("\n") }],
				details: { mode: "interactive" },
			};
		}

		const lines = [
			...(answers.length > 0
				? [`answered: ${answers.map((a) => `${a.header}: ${a.text}`).join("; ")}`]
				: []),
			...(unanswered.length > 0
				? [
						"not answered (no interactive UI or cancelled) — decide yourself per your judgment rules and note the choice:",
						...unanswered.map((u) => `- ${u}`),
					]
				: []),
		];
		return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "fallback" } };
	},
});

function outcomeFromDialog(item: AskQuestion, result: AskDialogResult): QuestionOutcome {
	if (result === undefined)
		return {
			unanswered: unansweredText(
				item,
				item.options.map((o) => o.label),
			),
		};
	if (result.kind === "chat") return { chat: { header: item.header, question: item.question } };
	if (result.kind === "custom")
		return { answer: { header: item.header, text: `${result.text} (custom)` } };
	const note = result.note ? ` (note: ${result.note})` : "";
	return { answer: { header: item.header, text: `${result.label}${note}` } };
}

function unansweredText(item: AskQuestion, labels: string[]): string {
	return `${item.header}: ${item.question}\n  options: ${labels.join(" | ")}`;
}

export function registerAsk(pi: ExtensionAPI): void {
	pi.registerTool(askTool);
}

export default function askExtension(pi: ExtensionAPI): void {
	registerAsk(pi);
}
