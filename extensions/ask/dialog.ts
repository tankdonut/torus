/**
 * torus — ask dialog component.
 *
 * Full-keyboard select dialog for torus_ask in TUI mode: arrows/j/k move,
 * digits jump-commit an option, `n` attaches a free-text note to the
 * highlighted row, `tab`/typing jumps into the always-present Custom…
 * free-text row, Enter commits, Esc steps back (input → selection) or
 * cancels. A "Chat more about this" row is always last. Options may carry
 * a `preview` (ASCII mockup, code snippet, diagram) rendered side-by-side
 * for the highlighted row.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isKeyRelease,
	type KeyId,
	matchesKey,
	parseKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export const CUSTOM_LABEL = "Custom…";
export const CHAT_LABEL = "Chat more about this";

export interface AskDialogOption {
	label: string;
	description?: string;
	/** Monospace preview (ASCII mockup, snippet, diagram) shown beside the options. */
	preview?: string;
}

export interface AskDialogSpec {
	header: string;
	question: string;
	/** 1-based question counter shown in the header, e.g. "1/2". */
	progress?: string;
	options: AskDialogOption[];
}

export type AskDialogResult =
	| { kind: "answer"; label: string; note?: string }
	| { kind: "custom"; text: string }
	| { kind: "chat" }
	| undefined; // cancelled

type InputMode = { field: "note" | "custom"; text: string } | null;

const PREVIEW_MIN_W = 24;
const PREVIEW_FRACTION = 0.42;

export class AskDialog implements Component {
	private tui: TUI;
	private theme: ExtensionContext["ui"]["theme"];
	private done: (result: AskDialogResult) => void;
	private spec: AskDialogOption[];
	private title: string;
	private hasPreview: boolean;
	private highlight = 0;
	private input: InputMode = null;
	private noteFor = new Map<number, string>(); // row index -> note
	private customText = "";
	private closed = false;

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		done: (result: AskDialogResult) => void,
		spec: AskDialogSpec,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.spec = spec.options;
		this.title = spec.header;
		this.hasPreview = spec.options.some((o) => o.preview !== undefined && o.preview !== "");
	}

	/** Rows: options, then Custom…, then Chat more about this. */
	private rows(): {
		kind: "option" | "custom" | "chat";
		label: string;
		option?: AskDialogOption;
	}[] {
		return [
			...this.spec.map((o) => ({ kind: "option" as const, label: o.label, option: o })),
			{ kind: "custom" as const, label: CUSTOM_LABEL },
			{ kind: "chat" as const, label: CHAT_LABEL },
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (isKeyRelease(data)) return;
		if (this.input) {
			this.handleTextInput(data);
		} else {
			this.handleSelectInput(data);
		}
		this.tui.requestRender();
	}

	private handleSelectInput(data: string): void {
		const rows = this.rows();
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.highlight = (this.highlight - 1 + rows.length) % rows.length;
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.highlight = (this.highlight + 1) % rows.length;
			return;
		}
		for (let i = 0; i < this.spec.length && i < 9; i++) {
			if (matchesKey(data, String(i + 1) as KeyId)) {
				this.highlight = i;
				this.commit();
				return;
			}
		}
		if (matchesKey(data, "n")) {
			this.input = { field: "note", text: this.noteFor.get(this.highlight) ?? "" };
			return;
		}
		if (matchesKey(data, "tab")) {
			this.highlight = this.spec.length; // Custom… row
			this.input = { field: "custom", text: this.customText };
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.commit();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.closed = true;
			this.done(undefined);
			return;
		}
		// Any other printable character seeds the custom answer (fast path).
		const key = parseKey(data);
		if (key !== undefined && key.length === 1 && !key.includes("+")) {
			this.highlight = this.spec.length;
			this.input = { field: "custom", text: key };
		}
	}

	private handleTextInput(data: string): void {
		const input = this.input;
		if (!input) return;
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.stashInput(input);
			this.input = null;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (input.field === "note") {
				if (input.text.trim()) this.noteFor.set(this.highlight, input.text.trim());
				else this.noteFor.delete(this.highlight);
			} else {
				this.customText = input.text;
			}
			this.input = null;
			return;
		}
		if (matchesKey(data, "backspace")) {
			input.text = input.text.slice(0, -1);
			return;
		}
		const key = parseKey(data);
		if (key === undefined) return;
		if (key === "space") {
			input.text += " ";
			return;
		}
		// Single unmodified printable only; reject ctrl/alt combos and named keys.
		if (key.length === 1 && !key.includes("+")) input.text += key;
	}

	private stashInput(input: NonNullable<InputMode>): void {
		if (input.field === "note") {
			if (input.text.trim()) this.noteFor.set(this.highlight, input.text.trim());
		} else {
			this.customText = input.text;
		}
	}

	private commit(): void {
		if (this.closed) return;
		const rows = this.rows();
		const row = rows[this.highlight];
		if (!row) return;
		this.closed = true;
		if (row.kind === "chat") {
			this.done({ kind: "chat" });
			return;
		}
		if (row.kind === "custom") {
			const text = (this.input?.field === "custom" ? this.input.text : this.customText).trim();
			if (!text) {
				// Empty custom answer: open the input instead of committing nothing.
				this.closed = false;
				this.input = { field: "custom", text: this.customText };
				return;
			}
			this.done({ kind: "custom", text });
			return;
		}
		this.done({ kind: "answer", label: row.label, note: this.noteFor.get(this.highlight) });
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = this.rows();
		const rule = t.fg("dim", "─".repeat(Math.max(0, width)));

		const title = truncateToWidth(this.title, Math.max(1, width));

		const lines: string[] = [rule, title, rule];

		if (this.hasPreview) {
			const paneW = Math.max(PREVIEW_MIN_W, Math.floor(width * PREVIEW_FRACTION));
			const listW = Math.max(8, width - paneW - 1);
			const left = this.renderRows(listW, false);
			const right = this.renderPane(paneW);
			const height = Math.max(left.length, right.length);
			for (let i = 0; i < height; i++) {
				const l = left[i] ?? "";
				const pad = Math.max(0, listW - visibleWidth(l));
				const r = right[i] ?? "";
				lines.push(`${l}${" ".repeat(pad)}${t.fg("dim", "│")}${r}`);
			}
		} else {
			lines.push(...this.renderRows(width, true));
		}

		lines.push(rule);
		if (this.input) {
			const field = this.input.field === "note" ? "note" : "custom answer";
			const target = this.input.field === "note" ? (rows[this.highlight]?.label ?? "") : undefined;
			const prompt = target ? `note for “${target}”` : field;
			const text = `${prompt}: ${this.input.text}▌`;
			lines.push(truncateToWidth(t.style(text, { fg: "accent", bold: true }), Math.max(1, width)));
		}
		lines.push(t.fg("dim", footer(this.input !== null)));
		lines.push("");
		return lines;
	}

	private renderRows(width: number, withDescriptions: boolean): string[] {
		const t = this.theme;
		const rows = this.rows();
		const lines: string[] = [];
		rows.forEach((row, i) => {
			const highlighted = i === this.highlight;
			const pointer = highlighted ? "❯ " : "  ";
			const digit = row.kind === "option" ? `${i + 1} ` : "  ";
			const note = this.noteFor.get(i);
			const noteTag = note ? ` ${t.fg("warning", "✎ note")}` : "";
			let text = `${pointer}${digit}${row.label}${noteTag}`;
			if (highlighted) text = t.style(text, { fg: "accent", bold: true });
			else if (row.kind !== "option") text = t.fg("dim", text);
			lines.push(truncateToWidth(text, Math.max(1, width)));
			if (withDescriptions && row.option?.description) {
				const desc = `      ${row.option.description}`;
				lines.push(truncateToWidth(t.fg("dim", desc), Math.max(1, width)));
			}
		});
		return lines;
	}

	private renderPane(width: number): string[] {
		const t = this.theme;
		const row = this.rows()[this.highlight];
		const option = row?.option;
		const lines: string[] = [];
		const title = option ? option.label : (row?.label ?? "");
		lines.push(truncateToWidth(t.style(title, { fg: "accent", bold: true }), Math.max(1, width)));
		if (option?.description) {
			for (const line of wrapPlain(option.description, width - 2)) {
				lines.push(truncateToWidth(t.fg("dim", line), Math.max(1, width)));
			}
		}
		if (option?.preview) {
			lines.push(t.fg("dim", "─".repeat(Math.max(0, width))));
			for (const line of option.preview.split("\n")) {
				lines.push(truncateToWidth(line, Math.max(1, width)));
			}
		} else if (this.hasPreview) {
			lines.push(t.fg("dim", "(no preview)"));
		}
		return lines;
	}
}

function footer(inInput: boolean): string {
	if (inInput) return "enter submit · esc back to options";
	return "↑↓/jk move · # pick · n note · tab custom · enter select · esc cancel";
}

function wrapPlain(text: string, width: number): string[] {
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(/\s+/)) {
			const candidate = line ? `${line} ${word}` : word;
			if (visibleWidth(candidate) > Math.max(1, width) && line) {
				out.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		out.push(line);
	}
	return out;
}
