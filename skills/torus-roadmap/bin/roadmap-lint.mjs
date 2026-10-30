#!/usr/bin/env node

// Lints a roadmap initiative file against the roadmap grammar. A valid file
// looks like this:
//
//   # Roadmap — <title>
//   Created: 2026-10-30
//   Status: active
//
//   ## Items
//
//   - R1. <title> — planned
//     Plan: <text>
//     Depends: R2, R3
//
//   - R2. <title> — done
//     Evidence: <text>
//     Decision: D1
//
// Item status is one of planned, in-flight, done, deferred, dropped. Detail
// lines sit under their item, indented by exactly two spaces, and carry one
// of the keys Plan, Evidence, Depends, Note, Decision; any other indented
// line is free prose.
//
//   ## Now / Next / Later
//
//   - Now: R1, R2
//   - Next: R3
//   - Later: none
//
// One row per lane; each row is the bare word none or a comma-separated list
// of item references.
//
//   ## Decision log
//
//   - D1 (2026-10-30): <text>
//
// The parts cross-check each other: item ids are unique; an in-flight item
// carries a Plan detail, a done item an Evidence detail, a deferred item a
// Note detail, and a dropped item a Decision detail; every Depends reference
// resolves to an item in the same file; every Decision reference resolves to
// a decision log row; the three lanes together list each planned or in-flight
// item exactly once and no item of any other status.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const USAGE = "usage: node roadmap-lint.mjs <file>...";

const TITLE_PREFIX = "# Roadmap — ";
const ROADMAP_STATUSES = ["active", "completed", "parked"];
const ITEM_STATUSES = ["planned", "in-flight", "done", "deferred", "dropped"];
const OPEN_STATUSES = new Set(["planned", "in-flight"]);
const REQUIRED_DETAIL = {
	"in-flight": "Plan",
	done: "Evidence",
	deferred: "Note",
	dropped: "Decision",
};
const LANES = ["Now", "Next", "Later"];

const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const ITEM_ROW_PREFIX = /^- R(\d+)\. (.+)$/;
const ITEM_ROW = new RegExp(`^- R(\\d+)\\. .+ — (${ITEM_STATUSES.join("|")})$`);
const DETAIL_ROW = /^ {2}(Plan|Evidence|Depends|Note|Decision): (.*)$/;
const DECISION_ROW_PREFIX = /^- D(\d+) \(/;
const LANE_ROW = /^- (Now|Next|Later): (.*)$/;
const ITEM_REF = /^R\d+$/;
const DECISION_REF = /^D\d+$/;

function lintRoadmap(path) {
	let source;
	try {
		source = readFileSync(path, "utf8");
	} catch {
		return [{ line: 0, message: "file not found" }];
	}
	const violations = [];
	const add = (line, message) => violations.push({ line, message });
	if (source.trim() === "") {
		add(1, "file is empty");
		return violations;
	}
	const lines = source
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	lintLines(lines, add);
	return violations.sort((a, b) => a.line - b.line);
}

function lintLines(lines, add) {
	checkTitle(lines[0], add);
	checkHeaderBlock(headerLines(lines), add);

	const sections = parseSections(lines);
	const itemsSections = sections.filter((section) => section.title === "Items");
	const laneSection = sections.find((section) => section.title === "Now / Next / Later") ?? null;
	const logSections = sections.filter((section) => section.title === "Decision log");

	if (itemsSections.length === 0) add(1, 'missing "## Items" section');
	if (!laneSection) add(1, 'missing "## Now / Next / Later" section');
	if (logSections.length === 0) add(1, 'missing "## Decision log" section');

	const { items, sawItemRow } = parseItems(itemsSections, add);
	if (itemsSections.length > 0 && !sawItemRow) {
		add(itemsSections[0].headingLine, "Items section must contain at least one item row");
	}
	checkUniqueItemIds(items, add);
	checkRequiredDetails(items, add);
	checkDependsRefs(items, add);
	checkDecisionRefs(items, collectDecisionIds(logSections), add);
	checkLanes(laneSection, items, add);
}

function checkTitle(firstLine, add) {
	if (!firstLine.startsWith(TITLE_PREFIX)) {
		add(1, `first line must be an H1 starting with "${TITLE_PREFIX.trim()}"`);
	}
}

// The header block is everything before the first "## " heading.
function headerLines(lines) {
	const header = [];
	for (let i = 0; i < lines.length; i++) {
		if (SECTION_HEADING.test(lines[i])) break;
		header.push({ text: lines[i], line: i + 1 });
	}
	return header;
}

function checkHeaderBlock(header, add) {
	let sawCreated = false;
	let sawStatus = false;
	for (const { text, line } of header) {
		if (text.startsWith("Created:")) {
			sawCreated = true;
			const value = text.slice("Created:".length).trim();
			if (!isIsoDate(value)) add(line, `Created must be a yyyy-mm-dd date, got "${value}"`);
		}
		if (text.startsWith("Status:")) {
			sawStatus = true;
			const value = text.slice("Status:".length).trim();
			if (!ROADMAP_STATUSES.includes(value)) {
				add(line, `Status must be one of ${ROADMAP_STATUSES.join("|")}, got "${value}"`);
			}
		}
	}
	if (!sawCreated) add(1, 'header block must contain a "Created: <yyyy-mm-dd>" line');
	if (!sawStatus) add(1, 'header block must contain a "Status: active|completed|parked" line');
}

function isIsoDate(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) return false;
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const longest = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= longest[month - 1];
}

function parseSections(lines) {
	const sections = [];
	let current = null;
	for (let i = 0; i < lines.length; i++) {
		const heading = SECTION_HEADING.exec(lines[i]);
		if (heading) {
			if (current) sections.push(current);
			current = { title: heading[1], headingLine: i + 1, body: [] };
		} else if (current) {
			current.body.push({ text: lines[i], line: i + 1 });
		}
	}
	if (current) sections.push(current);
	return sections;
}

function parseItems(itemsSections, add) {
	const items = [];
	let current = null;
	let sawItemRow = false;
	for (const section of itemsSections) {
		for (const { text, line } of section.body) {
			const row = ITEM_ROW.exec(text);
			if (row) {
				current = { id: `R${row[1]}`, status: row[2], line, details: new Map() };
				items.push(current);
				sawItemRow = true;
				continue;
			}
			const prefix = ITEM_ROW_PREFIX.exec(text);
			if (prefix) {
				// Looks like an item but does not parse as one; its details
				// are left dangling on purpose, they belong to no item.
				add(line, describeItemRowProblem(prefix[1], prefix[2]));
				current = null;
				sawItemRow = true;
				continue;
			}
			const detail = DETAIL_ROW.exec(text);
			if (detail && current) {
				const entries = current.details.get(detail[1]) ?? [];
				entries.push({ value: detail[2], line });
				current.details.set(detail[1], entries);
			}
		}
	}
	return { items, sawItemRow };
}

function describeItemRowProblem(id, rest) {
	const dash = rest.lastIndexOf(" — ");
	if (dash === -1) {
		return `item R${id} row must be "- R<n>. <title> — <status>"`;
	}
	const status = rest.slice(dash + 3);
	if (status === "") return `item R${id} has no status after the em dash`;
	return `item R${id} has invalid status "${status}" (expected ${ITEM_STATUSES.join("|")})`;
}

function checkUniqueItemIds(items, add) {
	const seen = new Set();
	for (const item of items) {
		if (seen.has(item.id)) add(item.line, `duplicate item id ${item.id}`);
		else seen.add(item.id);
	}
}

function checkRequiredDetails(items, add) {
	for (const item of items) {
		const key = REQUIRED_DETAIL[item.status];
		if (key && !item.details.has(key)) {
			add(item.line, `${item.status} item ${item.id} missing ${key} detail`);
		}
	}
}

function checkDependsRefs(items, add) {
	const ids = new Set(items.map((item) => item.id));
	for (const item of items) {
		for (const entry of item.details.get("Depends") ?? []) {
			if (entry.value.trim() === "") {
				add(entry.line, "Depends must list at least one item reference");
				continue;
			}
			for (const token of splitRefs(entry.value)) {
				if (!ITEM_REF.test(token)) add(entry.line, `Depends has invalid reference "${token}"`);
				else if (!ids.has(token)) add(entry.line, `Depends references unknown item ${token}`);
			}
		}
	}
}

function checkDecisionRefs(items, decisionIds, add) {
	for (const item of items) {
		for (const entry of item.details.get("Decision") ?? []) {
			if (entry.value.trim() === "") {
				add(entry.line, "Decision must list at least one decision reference");
				continue;
			}
			for (const token of splitRefs(entry.value)) {
				if (!DECISION_REF.test(token)) add(entry.line, `Decision has invalid reference "${token}"`);
				else if (!decisionIds.has(token)) {
					add(entry.line, `Decision references unknown decision ${token}`);
				}
			}
		}
	}
}

function collectDecisionIds(logSections) {
	const ids = new Set();
	for (const section of logSections) {
		for (const { text } of section.body) {
			const row = DECISION_ROW_PREFIX.exec(text);
			if (row) ids.add(`D${row[1]}`);
		}
	}
	return ids;
}

// Depends and Decision values are comma- or space-separated references.
function splitRefs(value) {
	return value.split(/[\s,]+/).filter((token) => token !== "");
}

function checkLanes(laneSection, items, add) {
	if (!laneSection) return;
	const byId = new Map(items.map((item) => [item.id, item]));
	const placed = new Map();
	const lanesSeen = new Map();
	for (const { text, line } of laneSection.body) {
		const row = LANE_ROW.exec(text);
		if (!row) continue;
		const [, lane, value] = row;
		if (lanesSeen.has(lane)) {
			add(line, `duplicate "${lane}:" row in Now / Next / Later`);
			continue;
		}
		lanesSeen.set(lane, line);
		for (const ref of laneRefs(lane, value, line, add)) {
			const item = byId.get(ref);
			if (!item) {
				add(line, `${lane} list references unknown item ${ref}`);
				continue;
			}
			if (!OPEN_STATUSES.has(item.status)) {
				add(line, `${lane} list references ${item.status} item ${ref}`);
				continue;
			}
			const firstLane = placed.get(ref);
			if (firstLane !== undefined) {
				add(line, `item ${ref} is already listed under ${firstLane}; listed again under ${lane}`);
				continue;
			}
			placed.set(ref, lane);
		}
	}
	for (const lane of LANES) {
		if (!lanesSeen.has(lane)) {
			add(laneSection.headingLine, `Now / Next / Later must have a "${lane}:" row`);
		}
	}
	for (const item of items) {
		if (OPEN_STATUSES.has(item.status) && !placed.has(item.id)) {
			add(item.line, `item ${item.id} ${item.status} but absent from Now/Next/Later`);
		}
	}
}

// A lane row holds the bare word none or comma-separated item references.
function laneRefs(lane, value, line, add) {
	const trimmed = value.trim();
	if (trimmed === "none") return [];
	if (trimmed === "") {
		add(line, `${lane} list must be "none" or comma-separated item references`);
		return [];
	}
	const refs = [];
	for (const token of trimmed.split(",")) {
		const ref = token.trim();
		if (ITEM_REF.test(ref)) refs.push(ref);
		else add(line, `${lane} list has invalid item reference "${ref}"`);
	}
	return refs;
}

function cli(argv) {
	if (argv.length === 0) {
		console.error(USAGE);
		return 2;
	}
	let failed = false;
	for (const path of argv) {
		const violations = lintRoadmap(path);
		if (violations.length === 0) {
			console.log(`ok ${path}`);
			continue;
		}
		failed = true;
		for (const { line, message } of violations) {
			console.log(`${path}:${line}: ${message}`);
		}
	}
	return failed ? 1 : 0;
}

const invokedAsMain =
	Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
	process.exitCode = cli(process.argv.slice(2));
}
