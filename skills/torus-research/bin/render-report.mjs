#!/usr/bin/env node
// Renders a torus-research journal markdown report into a standalone
// single-file HTML dossier. All raw HTML in the input is escaped and
// displayed as text — nothing passes through.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TEMPLATE_URL = new URL("../assets/report.html", import.meta.url);
const STYLES_URL = new URL("../assets/report.css", import.meta.url);

const SLOT_NAMES = ["CSS", "PREPAINT", "TITLE", "DATE", "MASTHEAD", "TOC", "CONTENT", "FOOTER"];
const LINK_PATTERN = /\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\(((?:[^()\s]|\([^()\n]*\))*)\)/g;
const ORDERED_ITEM = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;
const UNORDERED_ITEM = /^ {0,3}[-*+]\s+(.*)$/;

export function slugifyGithub(text) {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\w- ]/g, "")
		.replace(/ /g, "-");
}

export function contrastRatio(a, b) {
	const first = relativeLuminance(parseHexColor(a));
	const second = relativeLuminance(parseHexColor(b));
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

function parseHexColor(hex) {
	let digits = hex.trim().replace(/^#/, "");
	if (digits.length === 3) {
		digits = [...digits].map((c) => c + c).join("");
	}
	if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
		throw new TypeError(`not a hex color: ${hex}`);
	}
	return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
}

function relativeLuminance([r, g, b]) {
	const channel = (value) => {
		const srgb = value / 255;
		return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

const WORD_CHAR = /[A-Za-z0-9]/;
const QUOTE_OPENER_CONTEXT = /[\s([{"“‘—–*_]/;

function isOpeningContext(whole, offset) {
	const prev = whole[offset - 1] ?? "";
	return prev === "" || QUOTE_OPENER_CONTEXT.test(prev);
}

// Runs on text where code spans and links are already stashed behind
// \u0000 placeholders, so tags never exist yet and attribute quotes are safe.
function typographicNormalize(text) {
	return text
		.replace(/\.\.\./g, "…")
		.replace(/"/g, (_match, offset, whole) => (isOpeningContext(whole, offset) ? "“" : "”"))
		.replace(/'/g, (_match, offset, whole) => {
			const prev = whole[offset - 1] ?? "";
			const next = whole[offset + 1] ?? "";
			if (WORD_CHAR.test(prev)) return "’";
			if (isOpeningContext(whole, offset) && (WORD_CHAR.test(next) || next === "\u0000")) {
				return "‘";
			}
			return "’";
		});
}

function applyEmphasis(text) {
	return text
		.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
		.replace(/(?<![\w*])\*([^\n*]+?)\*(?![\w*])/g, "<em>$1</em>")
		.replace(/(?<![\w_])_([^\n_]+?)_(?!\w)/g, "<em>$1</em>");
}

function sanitizeUrl(url) {
	const trimmed = url.trim();
	if (/^(javascript|data|vbscript):/i.test(trimmed)) {
		return null;
	}
	return trimmed;
}

function stash(state, kind, html) {
	const store = kind === "C" ? state.code : state.links;
	return `\u0000${kind}${store.push(html) - 1}\u0000`;
}

function unstash(text, state) {
	let out = text;
	let previous = "";
	while (out !== previous) {
		previous = out;
		out = out.replace(/\u0000([CL])(\d+)\u0000/g, (_match, kind, index) =>
			kind === "C" ? state.code[Number(index)] : state.links[Number(index)],
		);
	}
	return out;
}

function renderInline(raw) {
	const state = { code: [], links: [] };
	let text = escapeHtml(raw);
	text = text.replace(/`([^`\n]+)`/g, (_match, content) =>
		stash(state, "C", `<code>${content}</code>`),
	);
	text = text.replace(LINK_PATTERN, (match, linkText, url) => {
		const href = sanitizeUrl(url);
		if (href === null) {
			return match;
		}
		return stash(state, "L", `<a href="${escapeAttribute(href)}">${applyEmphasis(linkText)}</a>`);
	});
	text = typographicNormalize(text);
	text = text.replace(/\[S(\d+)\]/g, '<span class="cite">[S$1]</span>');
	text = applyEmphasis(text);
	return unstash(text, state);
}

function plainText(raw) {
	return typographicNormalize(escapeHtml(raw));
}

function stripInlineMarkers(text) {
	return text
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^[\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*+([^*\n]+?)\*+/g, "$1")
		.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "$1");
}

export function parseMarkdown(source) {
	const lines = String(source).replace(/\r\n?/g, "\n").replace(/\0/g, "").split("\n");
	const blocks = parseBlocks(lines);
	let title = null;
	let meta = null;
	const h1 = blocks.findIndex((block) => block.type === "heading" && block.level === 1);
	if (h1 !== -1) {
		title = blocks[h1].text;
		blocks.splice(h1, 1);
		if (blocks[h1]?.type === "paragraph") {
			meta = blocks[h1].text;
			blocks.splice(h1, 1);
		}
	}
	return { title, meta, blocks };
}

function parseBlocks(lines) {
	const blocks = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i += 1;
			continue;
		}

		const fence = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line);
		if (fence) {
			const closing = new RegExp(`^ {0,3}${fence[1]}\\s*$`);
			const lang = fence[2].trim();
			i += 1;
			const body = [];
			while (i < lines.length && !closing.test(lines[i])) {
				body.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) {
				i += 1;
			}
			blocks.push({ type: "code", lang, text: body.join("\n") });
			continue;
		}

		const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			blocks.push({
				type: "heading",
				level: Math.min(heading[1].length, 4),
				text: heading[2],
			});
			i += 1;
			continue;
		}

		if (/^ {0,3}([-_*])(?:\s*\1){2,}\s*$/.test(line)) {
			blocks.push({ type: "hr" });
			i += 1;
			continue;
		}

		if (line.trim().startsWith("|") && isAlignmentRow(lines[i + 1] ?? "")) {
			const header = splitTableRow(line);
			const align = splitTableRow(lines[i + 1]).map(parseAlignCell);
			i += 2;
			const rows = [];
			while (i < lines.length && lines[i].trim().startsWith("|")) {
				rows.push(splitTableRow(lines[i]));
				i += 1;
			}
			blocks.push({ type: "table", header, align, rows });
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const inner = [];
			while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
				inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
				i += 1;
			}
			blocks.push({ type: "quote", blocks: parseBlocks(inner) });
			continue;
		}

		const ordered = ORDERED_ITEM.test(line);
		if (ordered || UNORDERED_ITEM.test(line)) {
			const pattern = ordered ? ORDERED_ITEM : UNORDERED_ITEM;
			const items = [];
			while (i < lines.length && lines[i].trim() !== "") {
				const item = pattern.exec(lines[i]);
				if (item) {
					items.push(item[1]);
				} else if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
					items[items.length - 1] += ` ${lines[i].trim()}`;
				} else {
					break;
				}
				i += 1;
			}
			const startMatch = /^ {0,3}(\d{1,9})[.)]\s/.exec(line);
			blocks.push({
				type: "list",
				ordered,
				start: startMatch ? Number(startMatch[1]) : 1,
				items,
			});
			continue;
		}

		const para = [line.trim()];
		i += 1;
		while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], lines[i + 1])) {
			para.push(lines[i].trim());
			i += 1;
		}
		blocks.push({ type: "paragraph", text: para.join("\n") });
	}
	return blocks;
}

function startsBlock(line, next) {
	if (/^ {0,3}(#{1,6}\s|>|```|~~~)/.test(line)) {
		return true;
	}
	if (/^ {0,3}([-*+]\s|\d{1,9}[.)]\s)/.test(line)) {
		return true;
	}
	if (/^ {0,3}([-_*])(?:\s*\1){2,}\s*$/.test(line)) {
		return true;
	}
	return line.trim().startsWith("|") && isAlignmentRow(next ?? "");
}

function splitTableRow(line) {
	let body = line.trim();
	if (body.startsWith("|")) {
		body = body.slice(1);
	}
	if (body.endsWith("|") && !body.endsWith("\\|")) {
		body = body.slice(0, -1);
	}
	return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isAlignmentRow(line) {
	if (!line.trim().startsWith("|")) {
		return false;
	}
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function parseAlignCell(cell) {
	if (cell.startsWith(":") && cell.endsWith(":")) {
		return "center";
	}
	if (cell.endsWith(":")) {
		return "right";
	}
	return "left";
}

function renderBlocks(blocks, ctx) {
	return blocks
		.map((block) => renderBlock(block, ctx))
		.filter(Boolean)
		.join("\n");
}

function renderBlock(block, ctx) {
	switch (block.type) {
		case "heading": {
			const id = headingId(block, ctx);
			return `<h${block.level} id="${id}">${renderInline(block.text)}</h${block.level}>`;
		}
		case "code": {
			const cls = block.lang ? ` class="language-${escapeAttribute(block.lang)}"` : "";
			return `<pre><code${cls}>${escapeHtml(block.text)}</code></pre>`;
		}
		case "hr":
			return "<hr>";
		case "quote":
			return `<blockquote>\n${renderBlocks(block.blocks, ctx)}\n</blockquote>`;
		case "list": {
			const tag = block.ordered ? "ol" : "ul";
			const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
			const items = block.items.map((item) => `<li>${renderInline(item)}</li>`).join("\n");
			return `<${tag}${start}>\n${items}\n</${tag}>`;
		}
		case "table":
			return renderTable(block);
		case "paragraph":
			return `<p>${renderInline(block.text)}</p>`;
		default:
			return "";
	}
}

function headingId(block, ctx) {
	const base = slugifyGithub(stripInlineMarkers(block.text)) || "section";
	const seen = ctx.used.get(base) ?? 0;
	ctx.used.set(base, seen + 1);
	const id = seen === 0 ? base : `${base}-${seen}`;
	ctx.headings.push({ level: block.level, text: block.text, id });
	return id;
}

function renderTable(block) {
	const width = block.header.length;
	const normalize = (cells) => {
		const out = cells.slice(0, width);
		while (out.length < width) {
			out.push("");
		}
		return out;
	};
	const alignAttr = (alignment) => {
		if (alignment === "center") {
			return ' style="text-align:center"';
		}
		if (alignment === "right") {
			return ' style="text-align:right"';
		}
		return "";
	};
	const head = normalize(block.header)
		.map((cell, j) => `<th${alignAttr(block.align[j])}>${renderInline(cell)}</th>`)
		.join("");
	const rows = block.rows
		.map((row) => {
			const cells = normalize(row)
				.map((cell, j) => `<td${alignAttr(block.align[j])}>${renderInline(cell)}</td>`)
				.join("");
			return `<tr>${cells}</tr>`;
		})
		.join("\n");
	return [
		'<div class="table-wrap">',
		"<table>",
		"<thead>",
		`<tr>${head}</tr>`,
		"</thead>",
		"<tbody>",
		rows,
		"</tbody>",
		"</table>",
		"</div>",
	].join("\n");
}

function renderToc(headings) {
	const entries = headings.filter((h) => h.level === 2 || h.level === 3);
	if (entries.length === 0) {
		return "";
	}
	const parts = [];
	let subs = null;
	for (const entry of entries) {
		const label = plainText(stripInlineMarkers(entry.text));
		if (entry.level === 2) {
			if (subs !== null) {
				parts.push(`<ul>${subs.join("")}</ul></li>`);
				subs = null;
			} else if (parts.length > 0) {
				parts.push("</li>");
			}
			parts.push(`<li><a href="#${entry.id}">${label}</a>`);
		} else {
			if (parts.length === 0) {
				parts.push("<li>");
			}
			if (subs === null) {
				subs = [];
			}
			subs.push(`<li><a href="#${entry.id}">${label}</a></li>`);
		}
	}
	if (subs !== null) {
		parts.push(`<ul>${subs.join("")}</ul></li>`);
	} else if (parts.length > 0) {
		parts.push("</li>");
	}
	return `<nav class="toc" aria-label="Contents">\n<ul>\n${parts.join("")}\n</ul>\n</nav>`;
}

function renderFooter({ sourcePath = null, renderedAt }) {
	const at = renderedAt instanceof Date ? renderedAt : new Date();
	const stamp = at.toISOString().replace(/\.\d+Z$/, "Z");
	const source = sourcePath ? ` from <code>${escapeHtml(sourcePath)}</code>` : "";
	return `<p>Rendered <time datetime="${stamp}">${stamp}</time>${source}.</p>`;
}

export function renderDocument(markdown, options = {}) {
	const template = options.template ?? readFileSync(TEMPLATE_URL, "utf8");
	const css = options.css ?? readFileSync(STYLES_URL, "utf8");
	const parsed = parseMarkdown(markdown);
	const ctx = { used: new Map(), headings: [] };
	const content = renderBlocks(parsed.blocks, ctx);
	const title = options.title ?? parsed.title ?? "Report";
	const masthead = [`<h1 class="report-title">${renderInline(title)}</h1>`];
	if (parsed.meta) {
		masthead.push(`<p class="meta">${renderInline(parsed.meta)}</p>`);
	}
	return fillSlots(template, {
		CSS: `<style>\n${css.trimEnd()}\n</style>`,
		PREPAINT: "",
		TITLE: plainText(title),
		DATE: options.date === null || options.date === undefined ? "" : escapeHtml(options.date),
		MASTHEAD: masthead.join("\n"),
		TOC: renderToc(ctx.headings),
		CONTENT: content,
		FOOTER: renderFooter(options),
	});
}

function fillSlots(template, fills) {
	let out = template;
	for (const name of SLOT_NAMES) {
		const marker = `<!--SLOT:${name}-->`;
		if (!out.includes(marker)) {
			throw new Error(`report template is missing the ${name} slot`);
		}
		out = out.replaceAll(marker, fills[name] ?? "");
	}
	const leftover = /<!--SLOT:[A-Z]+-->/.exec(out);
	if (leftover) {
		throw new Error(`report template has an unknown slot: ${leftover[0]}`);
	}
	return out;
}

function fail(message) {
	console.error(message);
	console.error("usage: node render-report.mjs <md-file-or-dir> [-o out.html] [--date YYYY-MM-DD]");
	process.exitCode = 1;
}

function dateFromDirname(mdPath) {
	const match = /^(\d{4}-\d{2}-\d{2})-/.exec(basename(dirname(mdPath)));
	return match ? match[1] : null;
}

function dateFromMtime(mdPath) {
	try {
		return statSync(mdPath).mtime.toISOString().slice(0, 10);
	} catch {
		return null;
	}
}

function cli(argv) {
	let args;
	try {
		args = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				output: { type: "string", short: "o" },
				date: { type: "string" },
			},
		});
	} catch (error) {
		fail(String(error.message));
		return;
	}

	const input = args.positionals[0];
	if (!input) {
		fail("no input given");
		return;
	}
	if (args.positionals.length > 1) {
		fail(`unexpected argument: ${args.positionals[1]}`);
		return;
	}
	const flagDate = args.values.date;
	if (flagDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flagDate)) {
		fail(`--date must be YYYY-MM-DD, got: ${flagDate}`);
		return;
	}

	let stat;
	try {
		stat = statSync(input);
	} catch {
		fail(`input not found: ${input}`);
		return;
	}
	const mdPath = stat.isDirectory() ? join(input, "REPORT.md") : input;
	if (stat.isDirectory() && !existsSync(mdPath)) {
		fail(`no REPORT.md in ${input}`);
		return;
	}
	let markdown;
	try {
		markdown = readFileSync(mdPath, "utf8");
	} catch {
		fail(`cannot read: ${mdPath}`);
		return;
	}

	const outPath =
		args.values.output ?? join(dirname(mdPath), `${basename(mdPath).replace(/\.[^.]+$/, "")}.html`);
	const date = flagDate ?? dateFromDirname(mdPath) ?? dateFromMtime(mdPath);

	let html;
	try {
		html = renderDocument(markdown, { date, sourcePath: resolve(mdPath) });
	} catch (error) {
		fail(`render failed: ${error.message}`);
		return;
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, html);
	console.log(outPath);
}

const invokedAsMain =
	Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
	cli(process.argv.slice(2));
}
