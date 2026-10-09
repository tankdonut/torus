import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-fsutil-project-"));
process.env["TORUS_HOME"] = home;

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
	assert.equal(
		fsutil.projectStateDir(),
		path.join(home, "state", fsutil.projectKey(process.cwd())),
	);
});

test("readJsonFallback: legacy used only when new file is absent, null wins", () => {
	const dir = mkdtempSync(path.join(home, "fallback-"));
	writeFileSync(path.join(dir, "legacy.json"), JSON.stringify({ v: 1 }), "utf8");
	const file = path.join(dir, "state.json");

	assert.deepEqual(fsutil.readJsonFallback(file, path.join(dir, "legacy.json"), null), { v: 1 });

	writeFileSync(file, "null", "utf8");
	assert.equal(fsutil.readJsonFallback(file, path.join(dir, "legacy.json"), { v: 2 }), null);
	assert.equal(
		fsutil.readJsonFallback(path.join(dir, "no.json"), path.join(dir, "nope.json"), "fb"),
		"fb",
	);
});

test("listDirUnion: deduped basename union, missing dirs contribute nothing", () => {
	const a = mkdtempSync(path.join(home, "union-a-"));
	const b = mkdtempSync(path.join(home, "union-b-"));
	writeFileSync(path.join(a, "shared.md"), "", "utf8");
	writeFileSync(path.join(a, "only-a.md"), "", "utf8");
	writeFileSync(path.join(b, "shared.md"), "", "utf8");
	writeFileSync(path.join(b, "only-b.md"), "", "utf8");

	assert.deepEqual([...fsutil.listDirUnion(a, b)].sort(), ["only-a.md", "only-b.md", "shared.md"]);
	assert.deepEqual(fsutil.listDirUnion(a, path.join(b, "missing")), ["only-a.md", "shared.md"]);
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
