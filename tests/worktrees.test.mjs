import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const {
	default: worktreesExtension,
	validateBranch,
	performCreate,
	performMerge,
	performRemove,
	gitEnv,
	runGit,
	worktreeRoot,
	worktreePath,
	resolveWorktreePath,
} = await import("../extensions/worktrees/index.ts");

const WT_ROOT = mkdtempSync(path.join(tmpdir(), "torus-wt-root-"));
const HOME_SANDBOX = mkdtempSync(path.join(tmpdir(), "torus-wt-home-"));
const repo = mkdtempSync(path.join(tmpdir(), "torus-wt-repo-"));

process.env["TORUS_WORKTREES_ROOT"] = WT_ROOT;
process.env["TORUS_HOME"] = HOME_SANDBOX;

// mirrors fsutil's projectKey: absolute cwd with "/"→"-", wrapped in "--"
const projectKey = (cwd) => `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;
const canonicalRoot = path.join(WT_ROOT, projectKey(repo));
const legacyRoot = path.join(WT_ROOT, path.basename(repo));

const sh = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });

function commitAll(cwd, message) {
	sh(cwd, ["add", "."]);
	const res = sh(cwd, ["commit", "-m", message]);
	assert.equal(res.status, 0, `commit failed: ${res.stderr}`);
}

before(() => {
	assert.equal(sh(repo, ["init", "-b", "main"]).status, 0);
	sh(repo, ["config", "user.email", "test@torus"]);
	sh(repo, ["config", "user.name", "torus-test"]);
	writeFileSync(path.join(repo, "base.txt"), "base\n");
	commitAll(repo, "init");
});

after(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(WT_ROOT, { recursive: true, force: true });
	rmSync(HOME_SANDBOX, { recursive: true, force: true });
});

test("validateBranch allowlists path-safe branch names only", () => {
	assert.equal(validateBranch("feat/x"), null);
	assert.equal(validateBranch("a-b_c.d/e"), null);
	assert.equal(validateBranch(""), "branch is required");
	assert.equal(validateBranch("../escape"), "branch must not contain '..'");
	assert.match(validateBranch("-rf"), /must match/);
	assert.match(validateBranch("rm -rf /"), /must match/);
	assert.match(validateBranch("a;sh"), /must match/);
	assert.match(validateBranch("/abs"), /must match/);
});

test("worktrees live outside the repo under TORUS_WORKTREES_ROOT/--<project-key>--/<branch>", async () => {
	const res = await performCreate(repo, "feat/location");
	assert.equal(res.ok, true, JSON.stringify(res));
	const wt = worktreePath(repo, "feat/location");
	assert.ok(wt.startsWith(WT_ROOT), `worktree outside override root: ${wt}`);
	assert.equal(
		wt,
		path.join(canonicalRoot, "feat/location"),
		"rooted under the canonical project key",
	);
	assert.ok(existsSync(path.join(wt, ".git")));
	await performRemove(repo, "feat/location");
});

test("worktreeRoot keys by the canonical project identity, not the bare basename", () => {
	assert.equal(worktreeRoot(repo), canonicalRoot);
	assert.notEqual(worktreeRoot(repo), legacyRoot);
	// same basename under a different parent must not collide
	const twinRepo = path.join(tmpdir(), "elsewhere", path.basename(repo));
	assert.notEqual(worktreeRoot(twinRepo), canonicalRoot);
});

test("full create→merge cycle lands via the canonical project-key path", async () => {
	assert.equal((await performCreate(repo, "feat/canonical-cycle")).ok, true);
	const wt = path.join(canonicalRoot, "feat/canonical-cycle");
	assert.ok(existsSync(path.join(wt, ".git")), `worktree at canonical path: ${wt}`);
	writeFileSync(path.join(wt, "canon.txt"), "canon\n");
	commitAll(wt, "add canon");

	const merge = await performMerge(repo, "feat/canonical-cycle", {
		subject: "feat: canonical cycle",
	});
	assert.equal(merge.ok, true, JSON.stringify(merge));
	assert.ok(existsSync(path.join(repo, "canon.txt")), "content landed on main");
	assert.ok(!existsSync(wt), "canonical worktree torn down");
});

test("resolver prefers canonical-when-present, basename-when-canonical-missing", () => {
	mkdirSync(path.join(canonicalRoot, "feat/twin"), { recursive: true });
	mkdirSync(path.join(legacyRoot, "feat/twin"), { recursive: true });
	assert.equal(resolveWorktreePath(repo, "feat/twin"), path.join(canonicalRoot, "feat/twin"));

	mkdirSync(path.join(legacyRoot, "feat/only-legacy"), { recursive: true });
	assert.equal(
		resolveWorktreePath(repo, "feat/only-legacy"),
		path.join(legacyRoot, "feat/only-legacy"),
	);

	// canonical missing → the basename form is the resolution default,
	// even when neither layout holds the branch (callers report "no worktree")
	assert.equal(
		resolveWorktreePath(repo, "feat/absent-both"),
		path.join(legacyRoot, "feat/absent-both"),
	);
});

test("legacy basename-rooted worktree still merges and tears down via the fallback", async () => {
	const legacyWt = path.join(legacyRoot, "feat/legacy");
	const add = sh(repo, ["worktree", "add", legacyWt, "-b", "feat/legacy"]);
	assert.equal(add.status, 0, `git worktree add failed: ${add.stderr}`);
	writeFileSync(path.join(legacyWt, "legacy.txt"), "legacy\n");
	commitAll(legacyWt, "add legacy file");

	assert.equal(
		resolveWorktreePath(repo, "feat/legacy"),
		legacyWt,
		"canonical twin absent: legacy wins",
	);

	const merge = await performMerge(repo, "feat/legacy", { subject: "feat: legacy worktree" });
	assert.equal(merge.ok, true, JSON.stringify(merge));
	assert.ok(existsSync(path.join(repo, "legacy.txt")), "legacy worktree content landed on main");
	assert.ok(!existsSync(legacyWt), "legacy worktree torn down via the fallback");
	assert.ok(
		!sh(repo, ["rev-parse", "--verify", "feat/legacy"]).stdout,
		"branch deleted post-proof",
	);
});

test("legacy basename-rooted worktree removes via the fallback, branch intact", async () => {
	const legacyWt = path.join(legacyRoot, "feat/legacy-remove");
	assert.equal(sh(repo, ["worktree", "add", legacyWt, "-b", "feat/legacy-remove"]).status, 0);
	const res = await performRemove(repo, "feat/legacy-remove");
	assert.equal(res.ok, true, JSON.stringify(res));
	assert.ok(!existsSync(legacyWt), "legacy worktree removed via the fallback");
	assert.ok(sh(repo, ["rev-parse", "--verify", "feat/legacy-remove"]).stdout, "branch survives");
});

test("create refuses duplicate worktrees", async () => {
	assert.equal((await performCreate(repo, "feat/dup")).ok, true);
	const second = await performCreate(repo, "feat/dup");
	assert.equal(second.ok, false);
	assert.match(second.error, /already exists/);
	await performRemove(repo, "feat/dup");
});

test("full cycle: create → commit → squash-merge lands one commit, tears down, deletes branch", async () => {
	assert.equal((await performCreate(repo, "feat/ship")).ok, true);
	const wt = worktreePath(repo, "feat/ship");
	writeFileSync(path.join(wt, "g.txt"), "new\n");
	commitAll(wt, "add g");

	const merge = await performMerge(repo, "feat/ship", { subject: "feat: ship g" });
	assert.equal(merge.ok, true, JSON.stringify(merge));

	const log = sh(repo, ["log", "--format=%B", "-2"]).stdout;
	assert.match(log, /feat: ship g/);
	assert.match(log, /Squash of feat\/ship \(1 commits?\)/);
	assert.ok(existsSync(path.join(repo, "g.txt")), "content landed on main");
	assert.ok(!existsSync(wt), "worktree removed");
	assert.ok(!sh(repo, ["rev-parse", "--verify", "feat/ship"]).stdout, "branch deleted post-proof");
});

test("ff merge preserves the commit series verbatim", async () => {
	assert.equal((await performCreate(repo, "feat/series")).ok, true);
	const wt = worktreePath(repo, "feat/series");
	writeFileSync(path.join(wt, "s1.txt"), "1\n");
	commitAll(wt, "s1");
	writeFileSync(path.join(wt, "s2.txt"), "2\n");
	commitAll(wt, "s2");

	const merge = await performMerge(repo, "feat/series", { strategy: "ff" });
	assert.equal(merge.ok, true, JSON.stringify(merge));
	const subjects = sh(repo, ["log", "--format=%s", "-2"]).stdout.split("\n");
	assert.deepEqual(subjects.slice(0, 2), ["s2", "s1"]);
});

test("remove never deletes the branch", async () => {
	assert.equal((await performCreate(repo, "feat/keep")).ok, true);
	const wt = worktreePath(repo, "feat/keep");
	writeFileSync(path.join(wt, "k.txt"), "k\n");
	commitAll(wt, "keep work");

	const res = await performRemove(repo, "feat/keep");
	assert.equal(res.ok, true, JSON.stringify(res));
	assert.ok(!existsSync(wt), "worktree removed");
	assert.ok(sh(repo, ["rev-parse", "--verify", "feat/keep"]).stdout, "branch survives removal");
});

test("merge refuses a dirty main checkout", async () => {
	assert.equal((await performCreate(repo, "feat/dirtymain")).ok, true);
	const wt = worktreePath(repo, "feat/dirtymain");
	writeFileSync(path.join(wt, "d.txt"), "d\n");
	commitAll(wt, "d");
	writeFileSync(path.join(repo, "base.txt"), "base\ndirty\n");

	const merge = await performMerge(repo, "feat/dirtymain", { subject: "x" });
	assert.equal(merge.ok, false);
	assert.match(merge.error, /main checkout has uncommitted changes/);
	assert.ok(existsSync(wt), "worktree kept on refusal");

	sh(repo, ["checkout", "--", "base.txt"]);
	assert.equal((await performRemove(repo, "feat/dirtymain")).ok, true);
});

test("remove refuses a dirty worktree unless forced", async () => {
	assert.equal((await performCreate(repo, "feat/dirtywt")).ok, true);
	const wt = worktreePath(repo, "feat/dirtywt");
	writeFileSync(path.join(wt, "base.txt"), "base\nmutated\n");

	const refuse = await performRemove(repo, "feat/dirtywt");
	assert.equal(refuse.ok, false);
	assert.match(refuse.error, /uncommitted/);
	assert.ok(existsSync(wt), "dirty worktree survives refusal");

	assert.equal((await performRemove(repo, "feat/dirtywt", { force: true })).ok, true);
	assert.ok(!existsSync(wt), "forced removal tears down");
});

test("rebase conflict aborts cleanly, keeping branch and worktree", async () => {
	assert.equal((await performCreate(repo, "feat/conflict")).ok, true);
	const wt = worktreePath(repo, "feat/conflict");
	writeFileSync(path.join(wt, "base.txt"), "worktree version\n");
	commitAll(wt, "worktree change");

	writeFileSync(path.join(repo, "base.txt"), "main version\n");
	commitAll(repo, "main change");

	const merge = await performMerge(repo, "feat/conflict", { subject: "x" });
	assert.equal(merge.ok, false);
	assert.match(merge.error, /aborted cleanly/);
	assert.ok(existsSync(wt), "worktree kept after conflict abort");
	assert.ok(sh(repo, ["rev-parse", "--verify", "feat/conflict"]).stdout, "branch kept");
	const status = sh(wt, ["status", "--porcelain"]).stdout;
	assert.equal(status, "", "no mid-flight rebase left behind");

	sh(repo, ["checkout", "--", "."]);
	assert.equal((await performRemove(repo, "feat/conflict", { force: true })).ok, true);
});

test("merge refuses a branch with no commits beyond main", async () => {
	assert.equal((await performCreate(repo, "feat/empty")).ok, true);
	const merge = await performMerge(repo, "feat/empty", { subject: "x" });
	assert.equal(merge.ok, false);
	assert.match(merge.error, /no commits beyond/);
	await performRemove(repo, "feat/empty");
});

test("runGit surfaces failures without throwing", async () => {
	const bad = await runGit(repo, ["rev-parse", "definitely-not-a-ref"]);
	assert.equal(bad.ok, false);
	assert.ok(bad.stderr.length > 0);
});

test("tool handlers set and clear the torus:worktree statusline chip", async () => {
	const tools = [];
	// hermetic under delegation children: registration is parent-session-only
	const ambientChild = process.env["TORUS_ENGINE_CHILD"];
	delete process.env["TORUS_ENGINE_CHILD"];
	try {
		worktreesExtension({ registerTool: (t) => tools.push(t) });
	} finally {
		if (ambientChild !== undefined) process.env["TORUS_ENGINE_CHILD"] = ambientChild;
	}
	assert.equal(tools.length, 3);
	const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

	const statuses = [];
	const ctx = {
		cwd: repo,
		ui: {
			setStatus: (key, value) => statuses.push([key, value]),
			theme: { fg: (_key, text) => text },
		},
	};

	const created = await byName.worktree_create.execute(
		"t1",
		{ branch: "feat/chip" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(created.content[0].text, /worktree ready/);
	assert.ok(
		statuses.some(([key, value]) => key === "torus:worktree" && /feat\/chip/.test(value)),
		"chip set after create",
	);

	const removed = await byName.worktree_remove.execute(
		"t2",
		{ branch: "feat/chip" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(removed.content[0].text, /removed worktree/);
	assert.ok(
		statuses.some(([key, value]) => key === "torus:worktree" && value === undefined),
		"chip cleared after remove",
	);
});

test("tool refusals carry isError so the TUI paints them red", async () => {
	const tools = [];
	const ambientChild = process.env["TORUS_ENGINE_CHILD"];
	delete process.env["TORUS_ENGINE_CHILD"];
	try {
		worktreesExtension({ registerTool: (t) => tools.push(t) });
	} finally {
		if (ambientChild !== undefined) process.env["TORUS_ENGINE_CHILD"] = ambientChild;
	}
	const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
	const ctx = { cwd: repo, ui: { setStatus: () => {}, theme: { fg: (_k, t) => t } } };

	const created = await byName.worktree_create.execute(
		"t1",
		{ branch: "feat/redflag" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(created.isError, false, "success must not flag isError");

	writeFileSync(path.join(repo, "base.txt"), "base\ndirty\n");
	try {
		const refused = await byName.worktree_merge.execute(
			"t2",
			{ branch: "feat/redflag", subject: "x" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(refused.isError, true, "refusal must carry isError: true");
		assert.match(refused.content[0].text, /error: /);
	} finally {
		sh(repo, ["checkout", "--", "base.txt"]);
		await performRemove(repo, "feat/redflag", { force: true });
	}
});

test("runGit scrubs ambient GIT_* env (pre-commit hooks export GIT_INDEX_FILE)", async () => {
	const polluted = gitEnv();
	for (const key of Object.keys(polluted)) {
		assert.ok(!key.startsWith("GIT_"), `GIT_ leaked through gitEnv: ${key}`);
	}
	process.env["GIT_INDEX_FILE"] = "/nonexistent/index";
	try {
		const status = await runGit(repo, ["status", "--porcelain"]);
		assert.equal(status.ok, true, `git failed under polluted env: ${status.stderr}`);
	} finally {
		delete process.env["GIT_INDEX_FILE"];
	}
});

test("worktree tools are parent-session only (TORUS_ENGINE_CHILD skips registration)", () => {
	const tools = [];
	const pi = { registerTool: (t) => tools.push(t) };

	process.env["TORUS_ENGINE_CHILD"] = "1";
	try {
		worktreesExtension(pi);
		assert.equal(tools.length, 0, "child sessions register no worktree tools");
	} finally {
		delete process.env["TORUS_ENGINE_CHILD"];
	}

	worktreesExtension(pi);
	assert.equal(tools.length, 3, "parent sessions register all three tools");
});

test("merge keeps the event loop alive (blocking spawns would freeze the TUI)", async () => {
	assert.equal((await performCreate(repo, "feat/nonblock")).ok, true);
	const wt = worktreePath(repo, "feat/nonblock");
	writeFileSync(path.join(wt, "nb.txt"), "nb\n");
	commitAll(wt, "nonblocking");

	const hook = path.join(repo, ".git", "hooks", "pre-commit");
	writeFileSync(hook, "#!/bin/sh\nsleep 1.5\n");
	chmodSync(hook, 0o755);
	sh(repo, ["config", "core.hooksPath", ".git/hooks"]);

	let ticks = 0;
	const ticker = setInterval(() => {
		ticks += 1;
	}, 25);
	try {
		const merge = await performMerge(repo, "feat/nonblock", { subject: "feat: nonblock" });
		assert.equal(merge.ok, true, JSON.stringify(merge));
	} finally {
		clearInterval(ticker);
		sh(repo, ["config", "--unset", "core.hooksPath"]);
		rmSync(hook, { force: true });
	}
	// sleep 1.5s hook runs during the squash commit: with async spawns the
	// interval fires ~60 times; with blocking spawns it fires 0 (loop frozen)
	assert.ok(ticks >= 10, `event loop starved during merge (only ${ticks} ticks in 1.5s+)`);
});
