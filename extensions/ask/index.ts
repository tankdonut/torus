import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const askTool = defineTool({
	name: "torus_ask",
	label: "Torus Ask",
	description:
		"Ask the user structured questions with labeled options (interactive select dialog), optionally accepting a typed custom answer. Use for scope decisions, destructive-action confirmation, or missing critical information. In non-interactive contexts the tool returns the options so you can decide and note the choice.",
	parameters: Type.Object({
		questions: Type.Array(
			Type.Object({
				question: Type.String(),
				header: Type.String({ description: "Very short label (max 30 chars)" }),
				options: Type.Array(
					Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }),
					{
						minItems: 2,
						maxItems: 6,
					},
				),
				allowCustom: Type.Optional(
					Type.Boolean({
						description:
							"Add a Custom… option that opens a text input; the typed answer is recorded verbatim",
					}),
				),
			}),
			{ minItems: 1, maxItems: 4 },
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const answers: string[] = [];
		const unanswered: string[] = [];

		for (const item of params.questions) {
			if (!ctx.hasUI) {
				unanswered.push(
					`${item.header}: ${item.question}\n  options: ${item.options.map((o) => o.label).join(" | ")}`,
				);
				continue;
			}
			const labels = [...item.options.map((o) => o.label)];
			if (item.allowCustom) labels.push("Custom…");
			const chosen = await ctx.ui.select(`${item.header} — ${item.question}`, labels);
			if (chosen === "Custom…") {
				const typed = (await ctx.ui.input(`${item.header} — custom answer`))?.trim();
				if (typed) {
					answers.push(`${item.header}: ${typed}`);
					continue;
				}
				unanswered.push(`${item.header}: ${item.question}\n  options: ${labels.join(" | ")}`);
			} else if (chosen === undefined) {
				unanswered.push(
					`${item.header}: ${item.question}\n  options: ${item.options.map((o) => o.label).join(" | ")}`,
				);
			} else {
				answers.push(`${item.header}: ${chosen}`);
			}
		}

		if (answers.length > 0 && unanswered.length === 0) {
			return {
				content: [{ type: "text", text: answers.join("\n") }],
				details: { mode: "interactive" },
			};
		}
		const lines = [
			...(answers.length > 0 ? [`answered: ${answers.join("; ")}`] : []),
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

export function registerAsk(pi: ExtensionAPI): void {
	pi.registerTool(askTool);
}

export default function askExtension(pi: ExtensionAPI): void {
	registerAsk(pi);
}
