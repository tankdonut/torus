import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	computePayloadHash,
	extractPayload,
	MARKER_NAME,
	readMarker,
	readMarkerDeps,
} from "../runtime/bin/payload-extract.mjs";

function tmpRoot() {
	return mkdtempSync(path.join(tmpdir(), "torus-payload-"));
}

test("computePayloadHash: order-independent, content- and path-sensitive", () => {
	const a = Buffer.from("alpha");
	const b = Buffer.from("beta");
	const one = computePayloadHash([
		{ path: "x.ts", bytes: a },
		{ path: "y.ts", bytes: b },
	]);
	const reordered = computePayloadHash([
		{ path: "y.ts", bytes: b },
		{ path: "x.ts", bytes: a },
	]);
	const swapped = computePayloadHash([
		{ path: "x.ts", bytes: b },
		{ path: "y.ts", bytes: a },
	]);
	const renamed = computePayloadHash([
		{ path: "z.ts", bytes: a },
		{ path: "y.ts", bytes: b },
	]);
	assert.equal(one, reordered);
	assert.notEqual(one, swapped);
	assert.notEqual(one, renamed);
});

test("extractPayload: writes nested files and the hash marker", () => {
	const root = tmpRoot();
	try {
		const files = [
			{ path: "extensions/a/index.ts", bytes: Buffer.from("export {};\n") },
			{ path: "agents/lead.md", bytes: Buffer.from("# lead\n") },
			{ path: "package.json", bytes: Buffer.from("{}\n") },
		];
		const hash = computePayloadHash(files);
		const written = extractPayload(root, hash, ["extensions", "agents"], files);
		assert.equal(written, 3);
		assert.equal(readFileSync(path.join(root, "extensions/a/index.ts"), "utf8"), "export {};\n");
		assert.equal(readMarker(root), hash);
		assert.equal(readFileSync(path.join(root, MARKER_NAME), "utf8"), `${hash}\n`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("extractPayload: wipes stale owned files, preserves unowned node_modules", () => {
	const root = tmpRoot();
	try {
		mkdirSync(path.join(root, "extensions/old"), { recursive: true });
		writeFileSync(path.join(root, "extensions/old/stale.ts"), "stale");
		mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
		writeFileSync(path.join(root, "node_modules/.bin/pi"), "engine");

		const files = [{ path: "extensions/new.ts", bytes: Buffer.from("new") }];
		extractPayload(root, computePayloadHash(files), ["extensions", "agents", "skills"], files);

		assert.equal(existsSync(path.join(root, "extensions/old/stale.ts")), false);
		assert.equal(existsSync(path.join(root, "extensions/new.ts")), true);
		assert.equal(readFileSync(path.join(root, "node_modules/.bin/pi"), "utf8"), "engine");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readMarker: null when missing or unreadable", () => {
	const root = tmpRoot();
	try {
		assert.equal(readMarker(root), null);
		writeFileSync(path.join(root, MARKER_NAME), "abc123\n");
		assert.equal(readMarker(root), "abc123");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("extractPayload: deps-hash round-trips on the marker's second line", () => {
	const root = tmpRoot();
	try {
		const files = [
			{ path: "extensions/a/index.ts", bytes: Buffer.from("export {};\n") },
			{ path: "package.json", bytes: Buffer.from("{}\n") },
		];
		const hash = computePayloadHash(files);
		extractPayload(root, hash, ["extensions"], files, "deadbeef");
		assert.equal(readFileSync(path.join(root, MARKER_NAME), "utf8"), `${hash}\ndeadbeef\n`);
		// line 1 stays the content hash for the fast-path comparison; line 2 is deps
		assert.equal(readMarker(root), hash);
		assert.equal(readMarkerDeps(root), "deadbeef");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readMarker: two-line marker yields only the content hash", () => {
	const root = tmpRoot();
	try {
		writeFileSync(path.join(root, MARKER_NAME), "contenthash\ndepshash\n");
		assert.equal(readMarker(root), "contenthash");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readMarkerDeps: null for missing marker, legacy single-line, or blank line", () => {
	const root = tmpRoot();
	try {
		assert.equal(readMarkerDeps(root), null);
		writeFileSync(path.join(root, MARKER_NAME), "abc123\n");
		assert.equal(readMarkerDeps(root), null, "legacy single-line marker has no deps line");
		writeFileSync(path.join(root, MARKER_NAME), "abc123\n\n");
		assert.equal(readMarkerDeps(root), null, "blank second line is not a deps hash");
		writeFileSync(path.join(root, MARKER_NAME), "abc123\ndeadbeef\n");
		assert.equal(readMarkerDeps(root), "deadbeef");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
