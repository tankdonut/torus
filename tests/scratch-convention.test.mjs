import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A /tmp subdirectory named as a destination in agent or skill prose is drift:
// durable work products belong under $TORUS_SCRATCH_DIR/<agent>/ (exported by
// extensions/fsutil.ts), and ephemeral mktemp temp lives in shell commands,
// never in prose destinations.
const TMP_SUBDIR = /\/tmp\/[A-Za-z0-9_.-]+\//g;

// Justified exceptions only. Each entry pins one exact matched path in one
// exact file; a stale entry (file or path gone) fails the suite below.
const ALLOWED_TMP_PATHS = [
	// { file: path.join("agents", "example.md"), path: "/tmp/example/" },
];

function collectProseFiles() {
	const rels = [];
	for (const entry of readdirSync(path.join(root, "agents"), { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".md")) rels.push(path.join("agents", entry.name));
	}
	for (const entry of readdirSync(path.join(root, "skills"), { withFileTypes: true })) {
		if (entry.isDirectory()) rels.push(path.join("skills", entry.name, "SKILL.md"));
	}
	return rels;
}

const files = collectProseFiles();

test("agent and skill files direct no work products into a /tmp subdirectory", () => {
	for (const rel of files) {
		const text = readFileSync(path.join(root, rel), "utf8");
		for (const hit of text.matchAll(TMP_SUBDIR)) {
			const allowed = ALLOWED_TMP_PATHS.some(
				(entry) => rel === entry.file && hit[0] === entry.path,
			);
			assert.ok(
				allowed,
				`${rel} directs work to ${hit[0]}: durable products belong under $TORUS_SCRATCH_DIR/<agent>/; ephemeral temp stays inside shell commands`,
			);
		}
	}
	for (const entry of ALLOWED_TMP_PATHS) {
		const stillPresent =
			files.includes(entry.file) &&
			readFileSync(path.join(root, entry.file), "utf8").includes(entry.path);
		assert.ok(
			stillPresent,
			`stale allowlist entry: ${entry.file} no longer contains ${entry.path}; remove the entry`,
		);
	}
});

test("librarian references the canonical scratch variable", () => {
	const text = readFileSync(path.join(root, "agents", "librarian.md"), "utf8");
	assert.ok(
		text.includes("$TORUS_SCRATCH_DIR"),
		"agents/librarian.md must reference $TORUS_SCRATCH_DIR, the canonical per-project scratch root",
	);
});

test("env convention is shared, not forked: roster owns it, team references it, leader carries it verbatim", async () => {
	const { ENV_CONVENTION } = await import("../extensions/roster/index.ts");
	const lines = ENV_CONVENTION.split("\n").filter((line) => line.length > 0);
	assert.ok(lines.length >= 2, "the convention is a multi-line block");

	const leader = readFileSync(path.join(root, "agents", "leader.md"), "utf8");
	for (const line of lines) {
		assert.ok(
			leader.includes(line),
			`agents/leader.md must carry every env-convention line verbatim (missing: ${line.slice(0, 40)}...)`,
		);
	}

	const teamRuntime = readFileSync(path.join(root, "extensions", "team-runtime.ts"), "utf8");
	assert.ok(
		/\bENV_CONVENTION\b/.test(teamRuntime),
		"team-runtime must reference the shared constant",
	);
	assert.ok(
		!/^Env: \$TORUS_STATE_DIR/m.test(teamRuntime),
		"team-runtime must not carry a forked copy of the env convention",
	);
});
