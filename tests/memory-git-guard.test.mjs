import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Memory-store write enforcement: the extension commits as `torus` with
// TORUS_MEMORY_COMMIT=1 in its spawn env, and a store-local pre-commit hook
// refuses every commit without that marker — so agent-run git cannot write
// history even if it bypasses the tool surface.
const home = mkdtempSync(path.join(tmpdir(), "torus-memory-git-guard-"));
process.env.TORUS_HOME = home;
delete process.env.TORUS_MEMORY_COMMIT;

const memory = await import("../extensions/memory/index.ts");
const store = path.join(home, "memory");

function toolText(result) {
	return result.content.map((part) => part.text).join("\n");
}

// Agent-simulating spawns: scrub ambient GIT_* (husky exports GIT_INDEX_FILE
// during pre-commit) so the test is hermetic regardless of how it runs.
function plainGit(args) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return spawnSync("git", ["-C", store, ...args], { env, encoding: "utf8" });
}

after(() => {
	rmSync(home, { recursive: true, force: true });
});

test("extension writes commit as torus and install the guard hook", async () => {
	const result = await memory.rememberTool.execute("t1", {
		topic: "Guard probe entry",
		content: "store enforcement probe",
	});
	assert.match(toolText(result), /remembered/);

	const author = plainGit(["log", "-1", "--format=%an <%ae>"]).stdout.trim();
	assert.equal(author, "torus <torus@local>", "extension commits must carry the canary identity");

	const hook = path.join(store, ".githooks", "pre-commit");
	assert.ok(existsSync(hook), "pre-commit hook must exist");
	const mode = statSync(hook).mode & 0o777;
	assert.ok(mode & 0o111, "pre-commit hook must be executable");
	assert.equal(
		plainGit(["config", "core.hooksPath"]).stdout.trim(),
		".githooks",
		"hooksPath must point at the store-local hooks dir",
	);
});

test("agent-run git commit on the store is refused by the pre-commit hook", () => {
	writeFileSync(path.join(store, "entries", "intruder.md"), "---\ntopic: intruder\n---\n", "utf8");
	const add = plainGit(["add", "--", "entries/intruder.md"]);
	assert.equal(add.status, 0, "staging is not what the hook guards");
	const commit = plainGit(["commit", "-m", "agent-written commit"]);
	assert.notEqual(commit.status, 0, "commit without TORUS_MEMORY_COMMIT must fail");
	assert.match(commit.stderr, /torus_remember/, "refusal must point at the tool surface");
	const log = plainGit(["log", "--format=%s"]).stdout;
	assert.ok(!log.includes("agent-written"), "no agent commit may land in history");
});

test("extension commits still pass the hook (carry the marker env)", async () => {
	const result = await memory.rememberTool.execute("t2", {
		topic: "Post-hook write",
		content: "must succeed through the hook",
	});
	assert.match(toolText(result), /remembered/);
	assert.match(
		plainGit(["log", "-1", "--format=%s"]).stdout,
		/Post-hook write/,
		"extension commit lands after the hook is installed",
	);
});
