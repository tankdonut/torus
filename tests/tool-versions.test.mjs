import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolVersions = readFileSync(path.join(root, ".tool-versions"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

function pinned(tool) {
	const m = toolVersions.match(new RegExp(`^${tool} (\\d+)\\.(\\d+)\\.(\\d+)$`, "m"));
	return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

test(".tool-versions pins exact nodejs and bun versions (no ranges or partials)", () => {
	for (const tool of ["nodejs", "bun"]) {
		assert.ok(
			pinned(tool),
			`.tool-versions must contain a line matching "^${tool} \\d+\\.\\d+\\.\\d+$"`,
		);
	}
});

test("pinned nodejs version satisfies package.json engines.node floor", () => {
	const pin = pinned("nodejs");
	assert.ok(pin, "nodejs pin missing from .tool-versions");
	const floor = String(pkg.engines?.node ?? "").match(/^>=(\d+)\.(\d+)$/);
	assert.ok(floor, `unsupported engines.node format: ${pkg.engines?.node}`);
	const floorMajor = Number(floor[1]);
	const floorMinor = Number(floor[2]);
	assert.ok(
		pin.major > floorMajor || (pin.major === floorMajor && pin.minor >= floorMinor),
		`nodejs pin ${pin.major}.${pin.minor}.x is below engines.node floor >=${floorMajor}.${floorMinor}`,
	);
});

test("ci.yml wires node and bun setup to .tool-versions", () => {
	assert.ok(
		ci.includes("node-version-file: .tool-versions"),
		"ci.yml must set node-version-file: .tool-versions on setup-node steps",
	);
	assert.ok(
		ci.includes("bun-version-file: .tool-versions"),
		"ci.yml must set bun-version-file: .tool-versions on setup-bun",
	);
});

test("ci.yml has no hardcoded node major pin", () => {
	assert.ok(
		!/node-version:\s*["']?\d/.test(ci),
		'ci.yml must not hardcode "node-version: <digit>..." — use node-version-file: .tool-versions',
	);
});
