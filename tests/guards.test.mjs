import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { isBareFileDump, isMemoryStoreMutation, recoveryGuidance, rewriteSimilarity, truncateText } =
	await import("../extensions/guards/index.ts");

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
