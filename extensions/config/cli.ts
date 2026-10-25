/**
 * torus config status — report the unified config.json's effective state.
 *
 * Booted only by the `torus config` launcher subcommand (runtime/bin/torus.mjs
 * intercepts it before the pi passthrough and calls runConfigCli); this module
 * is not a pi manifest extension. `status` reports each registered section's
 * effective source — config.json or default — plus config.json keys the
 * registry does not know and the project-level `.torus/config.json`'s
 * readable and refused sections.
 *
 * Reads config.json directly (node builtins + the section registry) so the
 * launcher path stays dependency-free; the subcommand resolves the torus home
 * from TORUS_HOME like every other torus-state consumer, which is also how
 * tests sandbox it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { torusHome } from "../fsutil.js";
import { loadProjectConfig, projectConfigPath } from "./loader.js";
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
 * present-but-unreadable one, and `value` is null unless the parse yielded a
 * plain object.
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
function sectionSource(config: Record<string, unknown> | null, section: SectionSpec): string {
	if (config && hasKey(config, section.name)) return "config.json";
	return "default";
}

function runStatus(home: string, out: (line: string) => void): number {
	const { value: config } = readJsonObject(configPath(home));
	for (const section of CONFIG_SECTIONS) {
		out(`${section.name}: ${sectionSource(config, section)}`);
	}
	// Sections already in config.json that the registry does not know (newer
	// or local keys) still deserve a line — status shows the whole file.
	if (config) {
		for (const key of Object.keys(config)) {
			if (!CONFIG_SECTIONS.some((section) => section.name === key)) out(`${key}: config.json`);
		}
	}
	const projectPath = projectConfigPath();
	if (existsSync(projectPath)) {
		const project = loadProjectConfig();
		const readable = Object.keys(project.config);
		out(
			`project: ${projectPath} (${readable.length > 0 ? `sections: ${readable.join(", ")}` : "no readable sections"})`,
		);
		if (project.ignored.length > 0) {
			out(`project refused: ${project.ignored.join(", ")}`);
		}
	} else {
		out(`project: none (${projectPath})`);
	}
	return 0;
}

/**
 * Entry point for the launcher's `torus config` subcommand. Returns the
 * process exit status: 0 on success, 2 on a usage error.
 */
export async function runConfigCli(args: string[]): Promise<number> {
	const out = (line: string) => process.stdout.write(`${line}\n`);
	const err = (line: string) => process.stderr.write(`${line}\n`);
	const home = torusHome();
	const usage = () => err("usage: torus config status");

	if (args[0] === "status") {
		if (args.length > 1) {
			usage();
			return 2;
		}
		return runStatus(home, out);
	}
	if (args.length > 0) err(`torus config: unknown subcommand: ${args[0]}`);
	usage();
	return 2;
}
