/**
 * torus — ask dialog component.
 *
 * Full-keyboard select dialog for torus_ask in TUI mode. Every question of a
 * call lives in one dialog: ←/→ (or h/l) moves between questions, the stepper
 * tabs at the top are clickable, and clicking a row commits it like Enter.
 * Within a question: arrows/j/k move, digits jump-commit an option, `n`
 * attaches a free-text note to the highlighted row, `tab`/typing jumps into
 * the always-present Custom… free-text row, Enter records the answer and
 * advances to the next question (the last one submits the whole set), and
 * Esc steps back (input → selection) or cancels the dialog. A "Chat more
 * about this" row is always last. Options may carry a `preview` (ASCII
 * mockup, code snippet, diagram) rendered side-by-side for the highlighted
 * row. Answers survive navigation: revisiting a question shows and lets you
 * change the recorded answer.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	isKeyRelease,
	type KeyId,
	matchesKey,
	parseKey,
	renderFakeCursor,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
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

export interface AskDialogQuestion {
	header: string;
	question: string;
	options: AskDialogOption[];
}

export interface AskDialogSpec {
	questions: AskDialogQuestion[];
}

export interface AskDialogAnswer {
	header: string;
	text: string;
}

export type AskDialogResult =
	| { kind: "submit"; answers: Array<AskDialogAnswer | null> }
	| {
			kind: "chat";
			/** Index of the question the chat row was chosen on. */
			index: number;
			header: string;
			question: string;
			/** Answers recorded before the chat choice, aligned with the question order. */
			answers: Array<AskDialogAnswer | null>;
	  }
	| undefined; // cancelled

type InputMode = { field: "note" | "custom"; text: string } | null;

/** Mutable state of one question: highlight, draft inputs, and the recorded answer. */
interface QuestionState {
	question: AskDialogQuestion;
	highlight: number;
	notes: Map<number, string>; // row index -> note
	customText: string;
	answer: AskDialogAnswer | null;
	/** Row index the recorded answer came from, or null while unanswered. */
	answeredRow: number | null;
}

const PREVIEW_MIN_W = 24;
const PREVIEW_FRACTION = 0.42;
const STEPPER_SEP = "  ";

/** Clickable horizontal extent of one stepper tab, in visible columns. */
interface TabSpan {
	start: number;
	end: number;
	index: number;
}

export class AskDialog implements Component {
	private tui: TUI;
	private theme: ExtensionContext["ui"]["theme"];
	private done: (result: AskDialogResult) => void;
	private states: QuestionState[];
	private qIndex = 0;
	private state: QuestionState;
	private input: InputMode = null;
	private closed = false;
	// Mouse hit regions, rebuilt on every render.
	private tabSpans: TabSpan[] = [];
	private stepperY = -1;
	private rowsTop = 0;
	private rowTargets: number[] = []; // rendered line (from rowsTop) -> row index
	private clickWidth = 0;

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		done: (result: AskDialogResult) => void,
		spec: AskDialogSpec,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.states = spec.questions.map((question) => ({
			question,
			highlight: 0,
			notes: new Map(),
			customText: "",
			answer: null,
			answeredRow: null,
		}));
		this.state = this.states[0] as QuestionState;
	}

	/** Rows for the current question: options, then Custom…, then Chat more about this. */
	private rows(): {
		kind: "option" | "custom" | "chat";
		label: string;
		option?: AskDialogOption;
	}[] {
		return [
			...this.state.question.options.map((o) => ({
				kind: "option" as const,
				label: o.label,
				option: o,
			})),
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || this.input) return undefined;
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y === this.stepperY) {
			for (const span of this.tabSpans) {
				if (event.x >= span.start && event.x < span.end) {
					this.gotoQuestion(span.index);
					return { handled: true };
				}
			}
			return undefined;
		}
		if (event.x < this.clickWidth) {
			const row = this.rowTargets[event.y - this.rowsTop];
			if (row !== undefined) {
				this.state.highlight = row;
				this.commit();
				return { handled: true };
			}
		}
		return undefined;
	}

	private handleSelectInput(data: string): void {
		const rows = this.rows();
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.gotoQuestion(this.qIndex - 1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			this.gotoQuestion(this.qIndex + 1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.state.highlight = (this.state.highlight - 1 + rows.length) % rows.length;
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.state.highlight = (this.state.highlight + 1) % rows.length;
			return;
		}
		const options = this.state.question.options;
		for (let i = 0; i < options.length && i < 9; i++) {
			if (matchesKey(data, String(i + 1) as KeyId)) {
				this.state.highlight = i;
				this.commit();
				return;
			}
		}
		if (matchesKey(data, "n")) {
			this.input = {
				field: "note",
				text: this.state.notes.get(this.state.highlight) ?? "",
			};
			return;
		}
		if (matchesKey(data, "tab")) {
			this.state.highlight = options.length; // Custom… row
			this.input = { field: "custom", text: this.state.customText };
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
			this.state.highlight = options.length;
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
				if (input.text.trim()) this.state.notes.set(this.state.highlight, input.text.trim());
				else this.state.notes.delete(this.state.highlight);
			} else {
				this.state.customText = input.text;
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
			if (input.text.trim()) this.state.notes.set(this.state.highlight, input.text.trim());
		} else {
			this.state.customText = input.text;
		}
	}

	private gotoQuestion(index: number): void {
		if (index < 0 || index >= this.states.length || index === this.qIndex) return;
		if (this.input) {
			this.stashInput(this.input);
			this.input = null;
		}
		this.qIndex = index;
		this.state = this.states[index] as QuestionState;
	}

	private commit(): void {
		if (this.closed) return;
		const q = this.state.question;
		const row = this.rows()[this.state.highlight];
		if (!row) return;
		if (row.kind === "chat") {
			this.closed = true;
			this.done({
				kind: "chat",
				index: this.qIndex,
				header: q.header,
				question: q.question,
				answers: this.states.map((s) => s.answer),
			});
			return;
		}
		if (row.kind === "custom") {
			const text = (
				this.input?.field === "custom" ? this.input.text : this.state.customText
			).trim();
			if (!text) {
				// Empty custom answer: open the input instead of committing nothing.
				this.input = { field: "custom", text: this.state.customText };
				return;
			}
			this.state.customText = text;
			this.state.answer = { header: q.header, text: `${text} (custom)` };
		} else {
			const note = this.state.notes.get(this.state.highlight);
			this.state.answer = {
				header: q.header,
				text: note ? `${row.label} (note: ${note})` : row.label,
			};
		}
		this.state.answeredRow = this.state.highlight;
		this.input = null;
		if (this.qIndex < this.states.length - 1) {
			this.gotoQuestion(this.qIndex + 1); // record, then continue with the next question
			return;
		}
		this.closed = true;
		this.done({ kind: "submit", answers: this.states.map((s) => s.answer) });
	}

	render(width: number): string[] {
		const t = this.theme;
		const q = this.state.question;
		const rows = this.rows();
		const rule = t.fg("dim", "─".repeat(Math.max(0, width)));
		const multi = this.states.length > 1;

		const lines: string[] = [rule];
		if (multi) {
			lines.push(...this.renderStepper(width));
			this.stepperY = 1;
			lines.push(rule);
		} else {
			this.stepperY = -1;
		}
		const title = truncateToWidth(`${q.header} — ${q.question}`, Math.max(1, width));
		lines.push(title, rule);
		this.rowsTop = lines.length;
		this.clickWidth = width;

		if (q.options.some((o) => o.preview !== undefined && o.preview !== "")) {
			const paneW = Math.max(PREVIEW_MIN_W, Math.floor(width * PREVIEW_FRACTION));
			const listW = Math.max(8, width - paneW - 1);
			this.clickWidth = listW;
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
			const target =
				this.input.field === "note" ? (rows[this.state.highlight]?.label ?? "") : undefined;
			const prompt = target ? `note for “${target}”` : field;
			// Same full-width fake-cursor cell the editor draws (not a thin “▌” glyph);
			// the marker marks it as the active input so it blinks and the hardware
			// cursor can sit on it. One column is reserved so truncation cannot drop
			// the cursor’s end marker.
			const styled = t.style(`${prompt}: ${this.input.text}`, { fg: "accent", bold: true });
			lines.push(
				truncateToWidth(styled, Math.max(1, width - 1)) + CURSOR_MARKER + renderFakeCursor(" "),
			);
		}
		lines.push(t.fg("dim", footer(this.input !== null, multi)));
		lines.push("");
		return lines;
	}

	/** Clickable question tabs: current in accent, answered ones carry a check. */
	private renderStepper(width: number): string[] {
		const t = this.theme;
		const count = this.states.length;
		const budget = Math.max(4, Math.floor((width - STEPPER_SEP.length * (count - 1)) / count) - 4);
		let line = "";
		let col = 0;
		const spans: TabSpan[] = [];
		this.states.forEach((s, i) => {
			if (col > 0) {
				line += t.fg("dim", STEPPER_SEP);
				col += STEPPER_SEP.length;
			}
			if (col >= width) return;
			const label = truncateToWidth(s.question.header, budget);
			const mark = s.answeredRow !== null ? ` ${t.fg("success", "✓")}` : "";
			const plain = `${i + 1} ${label}`;
			const text =
				i === this.qIndex ? t.style(plain, { fg: "accent", bold: true }) : t.fg("dim", plain);
			spans.push({ start: col, end: col + visibleWidth(`${plain}${mark}`), index: i });
			line += text + mark;
			col += visibleWidth(`${plain}${mark}`);
		});
		this.tabSpans = spans;
		return [truncateToWidth(line, Math.max(1, width))];
	}

	private renderRows(width: number, withDescriptions: boolean): string[] {
		const t = this.theme;
		const rows = this.rows();
		const lines: string[] = [];
		const targets: number[] = [];
		rows.forEach((row, i) => {
			const highlighted = i === this.state.highlight;
			const pointer = highlighted ? "❯ " : "  ";
			const digit = row.kind === "option" ? `${i + 1} ` : "  ";
			const note = this.state.notes.get(i);
			const noteTag = note ? ` ${t.fg("warning", "✎ note")}` : "";
			const answered = this.state.answeredRow === i ? ` ${t.fg("success", "✓")}` : "";
			let text = `${pointer}${digit}${row.label}${answered}${noteTag}`;
			if (highlighted) text = t.style(text, { fg: "accent", bold: true });
			else if (row.kind !== "option") text = t.fg("dim", text);
			lines.push(truncateToWidth(text, Math.max(1, width)));
			targets.push(i);
			if (withDescriptions && row.option?.description) {
				const desc = `      ${row.option.description}`;
				lines.push(truncateToWidth(t.fg("dim", desc), Math.max(1, width)));
				targets.push(i);
			}
		});
		this.rowTargets = targets;
		return lines;
	}

	private renderPane(width: number): string[] {
		const t = this.theme;
		const row = this.rows()[this.state.highlight];
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
		} else if (
			this.state.question.options.some((o) => o.preview !== undefined && o.preview !== "")
		) {
			lines.push(t.fg("dim", "(no preview)"));
		}
		return lines;
	}
}

function footer(inInput: boolean, multi: boolean): string {
	if (inInput) return "enter submit · esc back to options";
	if (multi) {
		return "←→/hl questions · ↑↓/jk move · # pick · n note · tab custom · enter select · esc cancel";
	}
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
