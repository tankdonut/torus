import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readTar, writeTar } from "../scripts/lib/tar.mjs";
import { packDir } from "../scripts/pack-payload-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir(t) {
	const dir = mkdtempSync(path.join(root, "dist", "payload-tree-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** node_modules-shaped fixture: nested files, an exec-bit shim, a symlink, dirs. */
function writeFixtureTree(base) {
	const tree = path.join(base, "node_modules");
	mkdirSync(path.join(tree, "example", "lib"), { recursive: true });
	mkdirSync(path.join(tree, ".bin"), { recursive: true });
	writeFileSync(path.join(tree, "example", "package.json"), '{"name":"example"}\n');
	writeFileSync(path.join(tree, "example", "lib", "util.js"), "export const util = 1;\n");
	writeFileSync(path.join(tree, ".bin", "tool"), "#!/usr/bin/env node\n");
	chmodSync(path.join(tree, ".bin", "tool"), 0o755);
	symlinkSync("../example/lib/util.js", path.join(tree, ".bin", "tool-link"));
	symlinkSync("../example", path.join(tree, "example-link"));
	return tree;
}

function entryByPath(entries, entryPath) {
	const found = entries.filter((entry) => entry.path === entryPath);
	assert.equal(found.length, 1, `exactly one entry for ${entryPath}`);
	return found[0];
}

test("tar round-trip: bytes, exec bit and symlink survive pack + unpack", (t) => {
	const tree = writeFixtureTree(tmpDir(t));
	const { tarGz } = packDir(tree);
	const entries = readTar(gunzipSync(tarGz));

	const pkg = entryByPath(entries, "example/package.json");
	assert.equal(pkg.typeflag, "0");
	assert.equal(pkg.bytes.toString(), '{"name":"example"}\n');

	const tool = entryByPath(entries, ".bin/tool");
	assert.equal(tool.mode & 0o111, 0o111, "the exec bit must be preserved");
	assert.equal(tool.bytes.toString(), "#!/usr/bin/env node\n");

	const link = entryByPath(entries, ".bin/tool-link");
	assert.equal(link.typeflag, "2");
	assert.equal(link.linkpath, "../example/lib/util.js");

	const dirLink = entryByPath(entries, "example-link");
	assert.equal(dirLink.typeflag, "2");
	assert.equal(dirLink.linkpath, "../example");
	assert.ok(
		!entries.some((entry) => entry.path.startsWith("example-link/")),
		"symlinks must not be traversed",
	);

	const dir = entryByPath(entries, "example");
	assert.equal(dir.typeflag, "5");
	assert.equal(dir.size, 0);
});

test("tar writer is deterministic: same tree packs to identical bytes", (t) => {
	const base = tmpDir(t);
	const first = packDir(writeFixtureTree(path.join(base, "one")));
	const second = packDir(writeFixtureTree(path.join(base, "two")));
	assert.deepEqual(first.tarGz, second.tarGz);
});

test("tar reader rejects hostile entry names", () => {
	const hostile = [
		{ path: "../escape", typeflag: "0", mode: 0o644, bytes: Buffer.from("x") },
		{ path: "/abs", typeflag: "0", mode: 0o644, bytes: Buffer.from("x") },
	];
	for (const entry of hostile) {
		const tar = writeTar([entry]);
		assert.throws(() => readTar(tar), /unsafe entry name/, entry.path);
	}
});

test("tar reader validates header checksums and accepts its own writer's output", () => {
	const tar = writeTar([
		{
			path: "node_modules/example/package.json",
			typeflag: "0",
			mode: 0o644,
			bytes: Buffer.from("{}\n"),
		},
	]);
	assert.equal(readTar(tar).length, 1, "the reader accepts an unmodified writer header");

	const tampered = Buffer.from(tar);
	tampered[100] = 0x37; // flip a mode digit without recomputing the checksum
	assert.throws(() => readTar(tampered), /checksum mismatch/);
});
