/**
 * torus config status|migrate — surface for the unified config.json.
 *
 * Booted only by the `torus config` launcher subcommand (runtime/bin/torus.mjs
 * intercepts it before the pi passthrough and calls runConfigCli); this module
 * is not a pi manifest extension. `status` reports each registered section's
 * effective source — config.json, its legacy standalone file, or default.
 * `migrate` folds every legacy file that has no config.json section yet into
 * config.json: plan-only without --yes, atomic write with it. Legacy files
 * are never modified or deleted; existing config sections and unknown
 * top-level keys are preserved verbatim, so a re-run only reports "kept".
 *
 * Reads config.json and the legacy files directly (node builtins + the
 * section registry) so the launcher path stays dependency-free; both
 * subcommands resolve the torus home from TORUS_HOME like every other
 * torus-state consumer, which is also how tests sandbox them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { torusHome } from "../fsutil.js";
import { CONFIG_SECTIONS, type SectionSpec } from "./sections.js";

const CONFIG_FILE_NAME = "config.json";

function configPath(home: string): string {
	return path.join(home, CONFIG_FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `file` as a JSON object: `exists` distinguishes a missing file from a
 * present-but-unreadable one (migrate refuses to touch the latter), and
 * `value` is null unless the parse yielded a plain object.
 */
function readJsonObject(file: string): { exists: boolean; value: Record<string, unknown> | null } {
	if (!existsSync(file)) return { exists: false, value: null };
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return { exists: true, value: isPlainObject(parsed) ? parsed : null };
	} catch {
		return { exists: true, value: null };
	}
}

function hasKey(object: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(object, key);
}

/** One status line per section: where its effective value comes from. */
function sectionSource(
	home: string,
	config: Record<string, unknown> | null,
	section: SectionSpec,
): string {
	if (config && hasKey(config, section.name)) return "config.json";
	if (section.legacyFile && existsSync(path.join(home, section.legacyFile))) {
		return `${path.join(home, section.legacyFile)} (legacy)`;
	}
	return "default";
}

function runStatus(home: string, out: (line: string) => void): number {
	const { value: config } = readJsonObject(configPath(home));
	for (const section of CONFIG_SECTIONS) {
		out(`${section.name}: ${sectionSource(home, config, section)}`);
	}
	// Sections already in config.json that the registry does not know (newer
	// or local keys) still deserve a line — status shows the whole file.
	if (config) {
		for (const key of Object.keys(config)) {
			if (!CONFIG_SECTIONS.some((section) => section.name === key)) out(`${key}: config.json`);
		}
	}
	return 0;
}

interface FoldEntry {
	name: string;
	legacyPath: string;
	value: unknown;
}

interface MigrationPlan {
	/** Parsed config.json contents (empty object when the file is absent). */
	base: Record<string, unknown>;
	fold: FoldEntry[];
	/** Top-level keys already in config.json (registry sections and unknown keys alike). */
	kept: string[];
	/** Registry sections with no foldable legacy file. */
	missing: string[];
}

/**
 * Compute the fold. A section migrates only when its legacy file exists AND
 * config.json does not already carry the key; a legacy file that fails to
 * parse is skipped with a warning (never folded as garbage, never fatal).
 */
function planMigration(
	home: string,
	warn: (line: string) => void,
): { plan: MigrationPlan | null; error: string | null } {
	const file = configPath(home);
	const { exists, value: config } = readJsonObject(file);
	if (exists && config === null) {
		return {
			plan: null,
			error: `${file} exists but is not a JSON object — fix or remove it first`,
		};
	}
	const base = config ?? {};
	const plan: MigrationPlan = { base, kept: Object.keys(base), fold: [], missing: [] };
	for (const section of CONFIG_SECTIONS) {
		if (hasKey(base, section.name)) continue;
		if (!section.legacyFile) {
			plan.missing.push(section.name);
			continue;
		}
		const legacyPath = path.join(home, section.legacyFile);
		if (!existsSync(legacyPath)) {
			plan.missing.push(section.name);
			continue;
		}
		try {
			const value: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
			plan.fold.push({ name: section.name, legacyPath, value });
		} catch {
			warn(`warning: skipping ${legacyPath} (not valid JSON)`);
		}
	}
	return { plan, error: null };
}

function printPlan(plan: MigrationPlan, out: (line: string) => void): void {
	if (plan.fold.length > 0) out(`will write sections: ${plan.fold.map((f) => f.name).join(", ")}`);
	if (plan.kept.length > 0) out(`kept (already in config.json): ${plan.kept.join(", ")}`);
	if (plan.missing.length > 0) out(`no legacy file: ${plan.missing.join(", ")}`);
}

/**
 * Atomic pretty write (2-space indent, trailing newline): temp file beside
 * the target, then rename, with the torus home created on demand.
 */
function writeConfig(file: string, data: Record<string, unknown>): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

function runMigrate(
	home: string,
	yes: boolean,
	out: (line: string) => void,
	err: (line: string) => void,
): number {
	const { plan, error } = planMigration(home, err);
	if (plan === null || error !== null) {
		err(`torus config migrate: ${error}`);
		return 1;
	}
	printPlan(plan, out);
	if (plan.fold.length === 0) {
		out("nothing to migrate");
		return 0;
	}
	if (!yes) {
		out("dry run: nothing written (pass --yes to write config.json)");
		return 0;
	}
	const file = configPath(home);
	const merged: Record<string, unknown> = { ...plan.base };
	for (const entry of plan.fold) merged[entry.name] = entry.value;
	writeConfig(file, merged);
	out(
		`migrated ${plan.fold.length} sections into ${file}; legacy files left in place — delete them when ready: ${plan.fold
			.map((f) => f.legacyPath)
			.join(", ")}`,
	);
	return 0;
}

/**
 * Entry point for the launcher's `torus config` subcommand. Returns the
 * process exit status: 0 on success, 2 on a usage error, 1 when the fold is
 * refused (e.g. an unreadable config.json).
 */
export async function runConfigCli(args: string[]): Promise<number> {
	const out = (line: string) => process.stdout.write(`${line}\n`);
	const err = (line: string) => process.stderr.write(`${line}\n`);
	const home = torusHome();
	const usage = () => err("usage: torus config status|migrate [--yes]");

	if (args[0] === "status") {
		if (args.length > 1) {
			usage();
			return 2;
		}
		return runStatus(home, out);
	}
	if (args[0] === "migrate") {
		const rest = args.slice(1);
		const valid = rest.length === 0 || (rest.length === 1 && rest[0] === "--yes");
		if (!valid) {
			usage();
			return 2;
		}
		return runMigrate(home, rest.includes("--yes"), out, err);
	}
	if (args.length > 0) err(`torus config: unknown subcommand: ${args[0]}`);
	usage();
	return 2;
}
