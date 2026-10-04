#!/usr/bin/env node
/**
 * Writes the payload tree (extensions/, agents/, skills/ + the runtime
 * package.json + .npmrc) to a target directory — the same shape the compiled
 * binary extracts to ~/.torus/runtime, from the same shared manifest source.
 * Container images bake this tree plus `npm install`ed node_modules so the
 * launcher resolves TORUS_ROOT and never bootstraps over the network.
 *
 * Usage: node scripts/bake-payload.mjs <targetDir>
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PAYLOAD_DIRS,
	payloadManifest,
	payloadNpmrc,
	payloadPackageJson,
} from "./payload-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] ?? "");

if (!process.argv[2]) {
	process.stderr.write("usage: node scripts/bake-payload.mjs <targetDir>\n");
	process.exit(1);
}
if (target === root) {
	// the payload package.json would clobber the repo manifest
	process.stderr.write("bake-payload: target must not be the repo root\n");
	process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const dir of PAYLOAD_DIRS) {
	cpSync(path.join(root, dir), path.join(target, dir), { recursive: true });
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
writeFileSync(path.join(target, "package.json"), payloadPackageJson(pkg));

const npmrc = payloadNpmrc();
if (npmrc !== null) {
	writeFileSync(path.join(target, ".npmrc"), npmrc);
}

const deps = Object.keys(payloadManifest(pkg).dependencies);
process.stderr.write(
	`baked payload to ${target} (payload dirs: ${PAYLOAD_DIRS.length}, deps: ${deps.length})\n`,
);
