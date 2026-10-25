import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-fsutil-project-"));
process.env["TORUS_HOME"] = home;
delete process.env["TORUS_ENGINE_CHILD"];
delete process.env["TORUS_STATE_DIR"];

const fsutil = await import("../extensions/fsutil.ts");

after(() => {
	rmSync(home, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function aged(file, days) {
	writeFileSync(file, "{}", "utf8");
	const stamp = new Date(Date.now() - days * DAY_MS);
	utimesSync(file, stamp, stamp);
}

test("projectKey mirrors pi's session directory scheme", () => {
	assert.equal(fsutil.projectKey("/var/home/x/y.tld/repo"), "--var-home-x-y.tld-repo--");
	assert.equal(fsutil.projectKey("/"), "----");
});

test("projectStateDir honors TORUS_HOME and defaults to process cwd", () => {
	assert.equal(fsutil.projectStateDir("/a/b"), path.join(home, "state", "--a-b--"));
	assert.equal(fsutil.projectStateDir(), fsutil.projectStateDir(process.cwd()));
});

// GIT_* leaks from git hooks (husky sets GIT_INDEX_FILE for pre-commit) and
// redirects index operations in the throwaway repos; scrub for identical
// behavior in and out of hooks (same contract as gitEnv in extensions/worktrees).
function cleanGitEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return env;
}

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: cleanGitEnv() });
	assert.equal(result.status, 0, `git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
}

function tempRepo(prefix) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const main = path.join(root, "main");
	git(root, "init", "-q", main);
	git(
		main,
		"-c",
		"user.email=t@torus.test",
		"-c",
		"user.name=torus",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"x",
	);
	return { root, main };
}

test("projectStateDir keys a linked worktree on the main checkout", () => {
	const { root, main } = tempRepo("torus-wt-key-");
	try {
		const wt = path.join(root, "wt");
		git(main, "worktree", "add", wt, "-b", "topic");
		const plain = path.join(root, "plain");
		mkdirSync(plain);

		const mainDir = fsutil.projectStateDir(main);
		assert.equal(fsutil.projectStateDir(wt), mainDir);
		assert.equal(mainDir, path.join(home, "state", fsutil.projectKey(main)));

		const plainDir = fsutil.projectStateDir(plain);
		assert.notEqual(plainDir, mainDir);
		assert.equal(
			plainDir,
			path.join(home, "state", `--${plain.replace(/^\/+/, "").replaceAll("/", "-")}--`),
		);
		assert.equal(fsutil.projectStateDir(plain), plainDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("projectStateDir keeps the raw key for cwds in the main checkout", () => {
	const { root, main } = tempRepo("torus-wt-sub-");
	try {
		const sub = path.join(main, "sub");
		mkdirSync(sub);
		assert.equal(fsutil.projectStateDir(sub), path.join(home, "state", fsutil.projectKey(sub)));
		assert.equal(fsutil.projectStateDir(main), path.join(home, "state", fsutil.projectKey(main)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("worktree canonical lookup runs once per cwd (later calls stay canonical)", () => {
	const { root, main } = tempRepo("torus-wt-cache-");
	try {
		const wt = path.join(root, "wt");
		git(main, "worktree", "add", wt, "-b", "topic");
		const first = fsutil.projectStateDir(wt);
		rmSync(path.join(wt, ".git"), { force: true });
		assert.equal(fsutil.projectStateDir(wt), first, "second call must not re-run git");
		assert.equal(first, fsutil.projectStateDir(main));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pruneOrphanSessionFiles: only orphan+old goes; live, unknown, and fresh stay", () => {
	const dir = mkdtempSync(path.join(home, "orphan-"));
	aged(path.join(dir, "gone-old.json"), 40);
	aged(path.join(dir, "live-old.json"), 40);
	aged(path.join(dir, "unknown-old.json"), 40);
	writeFileSync(path.join(dir, "gone-fresh.json"), "{}", "utf8");
	writeFileSync(path.join(dir, "not-session.txt"), "", "utf8");

	const exists = (id) => (id === "live-old" ? true : id === "unknown-old" ? null : false);

	assert.equal(fsutil.pruneOrphanSessionFiles(dir, exists, 30 * DAY_MS), 1);
	assert.ok(!existsSync(path.join(dir, "gone-old.json")));
	for (const kept of ["live-old.json", "unknown-old.json", "gone-fresh.json", "not-session.txt"]) {
		assert.ok(existsSync(path.join(dir, kept)), `${kept} must survive`);
	}
});

test("readFileCached: hit on unchanged stat, invalidated by rewrite, LRU-bounded, null on missing", () => {
	const dir = mkdtempSync(path.join(home, "read-cache-"));
	const file = path.join(dir, "a.txt");
	writeFileSync(file, "one\ntwo\n", "utf8");

	assert.equal(
		fsutil.readFileCached(path.join(dir, "missing.txt")),
		null,
		"missing file: null, nothing cached",
	);
	const before = fsutil._readCacheStats();
	assert.equal(fsutil.readFileCached(file), "one\ntwo\n");
	assert.equal(fsutil.readFileCached(file), "one\ntwo\n");
	const after = fsutil._readCacheStats();
	assert.equal(after.misses, before.misses + 1, "one read for two calls");
	assert.equal(after.hits, before.hits + 1, "second call is a hit");

	writeFileSync(file, "one\ntwo\nthree\n", "utf8");
	assert.equal(
		fsutil.readFileCached(file),
		"one\ntwo\nthree\n",
		"changed stat invalidates the entry",
	);

	for (let i = 0; i < 40; i++) {
		const bulk = path.join(dir, `bulk-${i}.txt`);
		writeFileSync(bulk, `bulk ${i}\n`, "utf8");
		fsutil.readFileCached(bulk);
	}
	assert.ok(fsutil._readCacheStats().size <= 32, "cache holds at most 32 entries");
	const missesAfterBulk = fsutil._readCacheStats().misses;
	assert.equal(fsutil.readFileCached(file), "one\ntwo\nthree\n");
	assert.equal(
		fsutil._readCacheStats().misses,
		missesAfterBulk + 1,
		"LRU-evicted entry is re-read, not resurrected",
	);
});
