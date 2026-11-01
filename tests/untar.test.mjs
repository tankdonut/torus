import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { extractTarGz, extractTree } from "../runtime/bin/untar.mjs";
import { packDir } from "../scripts/pack-payload-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpDir() {
	mkdirSync(path.join(root, "dist"), { recursive: true });
	return mkdtempSync(path.join(root, "dist", "untar-test-"));
}

function writeFixtureTree(base) {
	const tree = path.join(base, "node_modules");
	mkdirSync(path.join(tree, "example", "lib"), { recursive: true });
	mkdirSync(path.join(tree, ".bin"), { recursive: true });
	writeFileSync(path.join(tree, "example", "package.json"), '{"name":"example"}\n');
	writeFileSync(path.join(tree, "example", "lib", "util.js"), "export const util = 1;\n");
	writeFileSync(path.join(tree, ".bin", "tool"), "#!/usr/bin/env node\n");
	chmodSync(path.join(tree, ".bin", "tool"), 0o755);
	symlinkSync("../example/lib/util.js", path.join(tree, ".bin", "tool-link"));
	return tree;
}

test("round-trip: packed tree extracts with bytes, exec bit, and symlinks intact", () => {
	const base = tmpDir();
	try {
		writeFixtureTree(base);
		const { tarGz } = packDir(base);
		const dest = path.join(base, "dest");
		const counts = extractTarGz(tarGz, dest);
		assert.ok(counts.files >= 3, `expected packed files, got ${counts.files}`);
		assert.equal(
			readFileSync(path.join(dest, "node_modules", "example", "lib", "util.js"), "utf8"),
			"export const util = 1;\n",
		);
		const mode = statSync(path.join(dest, "node_modules", ".bin", "tool")).mode;
		assert.equal(mode & 0o111, 0o111, "the exec bit must survive extraction");
		assert.equal(
			readFileSync(path.join(dest, "node_modules", ".bin", "tool-link"), "utf8"),
			"export const util = 1;\n",
			"symlinks must resolve to the packed target",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("hostile names are rejected: .., foo/.., a/../b, absolute", () => {
	for (const name of ["..", "foo/..", "a/../b", "/etc/passwd"]) {
		const base = tmpDir();
		try {
			const archive = craftTar(name);
			assert.throws(
				() => extractTarGz(archive, path.join(base, "dest")),
				undefined,
				`entry ${name} must be rejected`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	}
});

test("a header with a wrong checksum aborts extraction", () => {
	const base = tmpDir();
	try {
		const archive = craftTar("node_modules/ok.js", { corruptChecksum: true });
		assert.throws(() => extractTarGz(archive, path.join(base, "dest")));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a truncated archive (no end-of-archive block) aborts extraction", () => {
	const base = tmpDir();
	try {
		const gz = craftTar("node_modules/ok.js");
		const truncated = gz.subarray(0, Math.max(1, Math.floor(gz.length / 2)));
		assert.throws(() => extractTarGz(truncated, path.join(base, "dest")));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("extractTree wipes node_modules first and rejects hostile entries", () => {
	const base = tmpDir();
	try {
		// the packer archives the node_modules directory itself, so entries are
		// relative to it and extractTree re-creates them under the target root
		const tree = writeFixtureTree(base);
		const { tarGz } = packDir(tree);

		const target = path.join(base, "target");
		mkdirSync(path.join(target, "node_modules", "stale"), { recursive: true });
		writeFileSync(path.join(target, "node_modules", "stale", "old.js"), "stale");
		extractTree(target, tarGz);
		assert.ok(
			!existsSync(path.join(target, "node_modules", "stale")),
			"the old tree must be wiped",
		);
		assert.ok(
			existsSync(path.join(target, "node_modules", "example", "package.json")),
			"the new tree must land under node_modules",
		);

		assert.throws(
			() => extractTree(target, craftTar("../escape.js")),
			"entries escaping node_modules must abort extraction",
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

/** Hand-craft a minimal one-entry tar.gz; the payload tree writer is not involved. */
function craftTar(name, { corruptChecksum = false } = {}) {
	const header = Buffer.alloc(512);
	header.write(name.slice(0, 99), 0, "latin1");
	header.write("0000644\0", 100, "latin1");
	header.write("00000000005\0", 124, "latin1"); // 5 data bytes
	header.write("        ", 148, "latin1"); // checksum placeholder spaces
	header.write("0", 156, "latin1");
	header.write("ustar\0", 257, "latin1");
	header.write("00", 263, "latin1");
	let sum = 0;
	for (const byte of header) sum += byte;
	if (corruptChecksum) sum += 1;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
	const data = Buffer.alloc(512);
	data.write("hello", 0, "latin1");
	const end = Buffer.alloc(1024);
	return gzipSync(Buffer.concat([header, data, end]), { level: 6 });
}
