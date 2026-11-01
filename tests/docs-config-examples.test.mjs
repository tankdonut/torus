import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The schema source is the config code itself: the registered sections, the
// project-readable knob sections, the approval knob section (user-level only,
// hence absent from the project list), the automode rules validator, the serve
// trigger validator, and the chains tiers. A docs example that drifts from any
// of these fails here instead of shipping a config snippet torus ignores.
const { CONFIG_SECTIONS, PROJECT_READABLE_SECTIONS } = await import(
	"../extensions/config/sections.ts"
);
const { validateRulesObject } = await import("../extensions/automode/config.ts");
const { validateTriggers } = await import("../extensions/serve/index.ts");
const { MODEL_CHAINS } = await import("../extensions/providers/index.ts");

// Every top-level key config.json accepts: registered sections, knob
// sections (approval is user-level only, hence absent from the project list).
const knownSections = new Set([
	...CONFIG_SECTIONS.map((section) => section.name),
	...PROJECT_READABLE_SECTIONS,
	"approval",
]);

test("the known-section set still carries the anchor sections", () => {
	for (const anchor of ["automode", "serve", "chains", "keywords", "permissionMode", "approval"]) {
		assert.ok(knownSections.has(anchor), `knownSections lost the "${anchor}" section`);
	}
});

// Every fenced json block in README.md, docs pages, and packaged skills.
function collectJsonBlocks() {
	const files = [path.join(root, "README.md")];
	for (const entry of readdirSync(path.join(root, "docs"), { withFileTypes: true })) {
		if (entry.name.endsWith(".md")) files.push(path.join(root, "docs", entry.name));
	}
	for (const entry of readdirSync(path.join(root, "skills"), { withFileTypes: true })) {
		const skill = path.join(root, "skills", entry.name, "SKILL.md");
		if (
			entry.isDirectory() &&
			readdirSync(path.join(root, "skills", entry.name)).includes("SKILL.md")
		) {
			files.push(skill);
		}
	}
	const blocks = [];
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		let open = false;
		let start = 0;
		let body = [];
		for (let i = 0; i < lines.length; i++) {
			if (open) {
				if (/^```\s*$/.test(lines[i])) {
					blocks.push({
						file: path.relative(root, file),
						line: start + 1,
						body: body.join("\n"),
						before: lines.slice(Math.max(0, start - 10), start),
					});
					open = false;
				} else {
					body.push(lines[i]);
				}
			} else if (/^```json\s*$/.test(lines[i])) {
				open = true;
				start = i;
				body = [];
			}
		}
	}
	return blocks;
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BOUNDARY_RULE_KEYS = ["softDeny", "softDenyExceptions", "hardDeny", "classifyAllShell"];

function checkBlock(block) {
	const where = `${block.file}:${block.line}`;
	let parsed;
	try {
		parsed = JSON.parse(block.body);
	} catch {
		return [`${where}: json fence is not valid JSON; config examples must be complete objects`];
	}
	if (!isPlainObject(parsed)) return [];
	const keys = Object.keys(parsed);

	// A config.json example: one known top-level section means every key must
	// be one, and each carried section must pass its real validator.
	if (keys.some((key) => knownSections.has(key))) {
		const problems = keys
			.filter((key) => !knownSections.has(key))
			.map((key) => `${where}: top-level key "${key}" is not a config section`);
		const automode = parsed["automode"];
		if (automode !== undefined) {
			if (!isPlainObject(automode)) {
				problems.push(`${where}: "automode" must be an object`);
			} else {
				const { warnings } = validateRulesObject(automode, `${where} (automode section)`);
				problems.push(...warnings);
			}
		}
		const permissionMode = parsed["permissionMode"];
		if (permissionMode !== undefined && permissionMode !== "auto" && permissionMode !== "default") {
			problems.push(
				`${where}: "permissionMode" must be "auto" or "default" (got ${JSON.stringify(permissionMode)})`,
			);
		}
		const serve = parsed["serve"];
		if (serve !== undefined) {
			if (!isPlainObject(serve)) {
				problems.push(`${where}: "serve" must be an object`);
			} else {
				for (const key of Object.keys(serve)) {
					if (!["port", "bind", "tokenPath", "triggers"].includes(key)) {
						problems.push(`${where}: "serve" has no "${key}" key`);
					}
				}
				if (serve["port"] !== undefined && typeof serve["port"] !== "number") {
					problems.push(`${where}: "serve"."port" must be a number`);
				}
				if (
					serve["bind"] !== undefined &&
					(typeof serve["bind"] !== "string" || serve["bind"] === "")
				) {
					problems.push(`${where}: "serve"."bind" must be a non-empty string`);
				}
				if (serve["tokenPath"] !== undefined && typeof serve["tokenPath"] !== "string") {
					problems.push(`${where}: "serve"."tokenPath" must be a string`);
				}
				const { error } = validateTriggers(serve["triggers"]);
				if (error !== null) problems.push(`${where}: ${error}`);
			}
		}
		const chains = parsed["chains"];
		if (chains !== undefined) {
			if (!isPlainObject(chains)) {
				problems.push(`${where}: "chains" must be an object`);
			} else {
				const tierNames = Object.keys(MODEL_CHAINS);
				for (const key of Object.keys(chains)) {
					if (key !== "providers" && !tierNames.includes(key)) {
						problems.push(`${where}: "chains" has no "${key}" tier`);
					}
				}
				for (const tier of tierNames) {
					const entries = chains[tier];
					if (entries === undefined) continue;
					const validTier =
						Array.isArray(entries) &&
						entries.length > 0 &&
						entries.every((entry) => typeof entry === "string" && entry.trim().length > 0);
					if (!validTier) {
						problems.push(`${where}: "chains"."${tier}" must be a non-empty array of model ids`);
					}
				}
			}
		}
		return problems;
	}

	// A bare automode section: every key is a valid rule key, so the block is
	// the section's contents shown where config.json is the subject. Paste
	// validity requires the "automode" wrapper; boundary keys ride only in
	// config.json (the setup-draft flow refuses them), so they always need it.
	const { rules, warnings } = validateRulesObject(parsed, where);
	if (warnings.length === 0 && Object.keys(rules).length > 0) {
		const carriesBoundaryKey = BOUNDARY_RULE_KEYS.some((key) => rules[key] !== undefined);
		const mentionsConfigJson = block.before.some((line) => line.includes("config.json"));
		if (carriesBoundaryKey || mentionsConfigJson) {
			return [`${where}: automode rules example needs its "automode" section wrapper`];
		}
	}
	return [];
}

test("every config example in the docs matches the actual config schema", () => {
	const blocks = collectJsonBlocks();
	assert.ok(blocks.length >= 6, `json-block extraction looks broken (found ${blocks.length})`);
	const problems = blocks.flatMap(checkBlock);
	assert.deepEqual(problems, []);
});

test("the check catches a bare automode section shown beside config.json prose", () => {
	const bare = {
		file: "docs/example.md",
		line: 4,
		body: '{\n  "deny": ["git push --force *"]\n}\n',
		before: ["paste into `~/.torus/config.json`:", "", "```json"],
	};
	assert.match(checkBlock(bare)[0] ?? "", /needs its "automode" section wrapper/);
});
