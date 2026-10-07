import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const {
	dumpBlockReason,
	hasSymlinkInPath,
	isBareFileDump,
	isMemoryStoreMutation,
	recoveryGuidance,
	rewriteSimilarity,
	truncateText,
	writeBlockReason,
} = await import("../extensions/guards/index.ts");

test("truncateText: under cap untouched; over cap keeps head+tail and reports omission", () => {
	const short = "a".repeat(100);
	assert.equal(truncateText(short, 1000), short);
	const long = `${"H".repeat(6000)}MIDDLE${"T".repeat(6000)}`;
	const out = truncateText(long, 1000);
	assert.match(out, /truncated \d+ bytes/);
	assert.ok(out.startsWith("H".repeat(600)));
	assert.ok(out.endsWith("T".repeat(250)));
	assert.ok(!out.includes("MIDDLE"));
});

test("isMemoryStoreMutation: mutating git on the store blocked, read-only and foreign repos allowed", () => {
	const store = "/home/u/.torus/memory";
	assert.equal(isMemoryStoreMutation(`git -C ${store} commit -m tidy`, store), true);
	assert.equal(
		isMemoryStoreMutation(`git -C ${store} add -A && git -C ${store} commit`, store),
		true,
	);
	assert.equal(isMemoryStoreMutation("cd ~/.torus/memory && git rebase -i main", store), true);
	assert.equal(
		isMemoryStoreMutation(`git -C ${store} log --oneline -5`, store),
		false,
		"read-only inspection stays open",
	);
	assert.equal(isMemoryStoreMutation(`git -C ${store} status`, store), false);
	assert.equal(
		isMemoryStoreMutation("git commit -m 'repo work'", store),
		false,
		"foreign repo without store reference",
	);
	assert.equal(isMemoryStoreMutation(`git -C ${store} commit --no-verify -m x`, store), true);
	assert.equal(
		isMemoryStoreMutation("echo x >> ~/.torus/memory/entries/new.md", store),
		true,
		"redirect needle form",
	);
	assert.equal(isMemoryStoreMutation(`rm ${store}/entries/stale.md`, store), true);
	assert.equal(isMemoryStoreMutation("sed -i s/a/b/ ~/.torus/memory/profile.md", store), true);
	assert.equal(
		isMemoryStoreMutation("cat ~/.torus/memory/entries/e.md", store),
		false,
		"reads are not mutations",
	);
});

test("isBareFileDump: only plain absolute-file cat/head/tail/less/more of real files", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-guards-"));
	const file = path.join(dir, "x.txt");
	writeFileSync(file, "content\n");
	assert.equal(isBareFileDump(`cat ${file}`), true);
	assert.equal(isBareFileDump(`head -40 ${file}`), true);
	assert.equal(isBareFileDump(`tail -n 5 ${file}`), true);
	assert.equal(isBareFileDump(`cat ${file} | grep x`), false);
	assert.equal(isBareFileDump("cat relative/x.txt"), false);
	assert.equal(isBareFileDump(`cat ${path.join(dir, "missing.txt")}`), false);
	assert.equal(isBareFileDump(`python3 ${file}`), false);
});

test("rewriteSimilarity: identical rewrites score 1, disjoint score 0", () => {
	const disk = "a\nb\nc\nd\ne\n";
	assert.equal(rewriteSimilarity(disk, disk), 1);
	assert.equal(rewriteSimilarity(disk, "x\ny\nz\nw\nv\n"), 0);
	const mixed = rewriteSimilarity(disk, "a\nb\nc\nx\ny\n");
	assert.ok(mixed > 0.5 && mixed < 0.7, `mixed similarity out of range: ${mixed}`);
});

test("recoveryGuidance: edit and json variants are distinct, actionable", () => {
	const edit = recoveryGuidance("edit");
	const json = recoveryGuidance("json");
	assert.match(edit, /hashline_edit/);
	assert.match(json, /jq/);
	assert.notEqual(edit, json);
});

test("hasSymlinkInPath: symlinked component anywhere in the path is flagged; real nested paths are not", () => {
	const base = realpathSync(tmpdir());
	const dir = mkdtempSync(path.join(base, "torus-guards-"));
	const outsideDir = mkdtempSync(path.join(base, "torus-outside-"));
	const outside = path.join(outsideDir, "secret.txt");
	writeFileSync(outside, "secret\n");
	symlinkSync(outside, path.join(dir, "escape"));
	mkdirSync(path.join(dir, "real", "nested"), { recursive: true });
	symlinkSync(path.join(dir, "real"), path.join(dir, "linkdir"));
	assert.equal(hasSymlinkInPath(path.join(dir, "escape")), true, "final component is a symlink");
	assert.equal(
		hasSymlinkInPath(path.join(dir, "linkdir", "nested", "newfile")),
		true,
		"intermediate directory is a symlink, trailing component does not exist yet",
	);
	assert.equal(
		hasSymlinkInPath(path.join(dir, "real", "nested", "file")),
		false,
		"real nested path with no symlinks",
	);
});

test("writeBlockReason: symlinked write targets blocked, real nested targets allowed", () => {
	const base = realpathSync(tmpdir());
	const dir = mkdtempSync(path.join(base, "torus-guards-"));
	const outsideDir = mkdtempSync(path.join(base, "torus-outside-"));
	const outside = path.join(outsideDir, "secret.txt");
	writeFileSync(outside, "secret\n");
	symlinkSync(outside, path.join(dir, "escape"));
	mkdirSync(path.join(dir, "real", "nested"), { recursive: true });
	symlinkSync(path.join(dir, "real"), path.join(dir, "linkdir"));
	assert.match(
		String(writeBlockReason(path.join(dir, "escape"), "payload\n")),
		/symbolic link in path/,
		"write target is itself a symlink",
	);
	assert.match(
		String(writeBlockReason(path.join(dir, "linkdir", "nested", "newfile"), "payload\n")),
		/symbolic link in path/,
		"symlink as an intermediate directory component",
	);
	assert.equal(
		writeBlockReason(path.join(dir, "real", "nested", "file"), "payload\n"),
		null,
		"real nested target with no symlinks is allowed (no false positive)",
	);
});

test("dumpBlockReason: cat through a symlink is blocked with the symlink reason, real files keep the read-tool reason", () => {
	const base = realpathSync(tmpdir());
	const dir = mkdtempSync(path.join(base, "torus-guards-"));
	const outsideDir = mkdtempSync(path.join(base, "torus-outside-"));
	const outside = path.join(outsideDir, "secret.txt");
	writeFileSync(outside, "secret\n");
	symlinkSync(outside, path.join(dir, "escape"));
	const realFile = path.join(dir, "x.txt");
	writeFileSync(realFile, "content\n");
	assert.match(
		dumpBlockReason(`cat ${path.join(dir, "escape")}`),
		/symbolic link in path/,
		"read-dump of an absolute path through a symlink",
	);
	assert.ok(!/symbolic link/.test(String(dumpBlockReason(`cat ${realFile}`))));
	assert.equal(dumpBlockReason("cat relative/x.txt"), null);
});
