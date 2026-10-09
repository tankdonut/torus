#!/usr/bin/env node
/**
 * Shared payload-manifest definition — the single source of truth for the
 * runtime package.json shape the compiled binary embeds (via
 * generate-payload-assets.mjs) and the container image bakes (via
 * bake-payload.mjs). Keep the serialized form stable: the payload hash keys
 * ~/.torus/runtime re-extraction off its exact bytes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAYLOAD_DIRS = ["extensions", "agents", "skills"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The engine pin is deliberately a devDependency toolchain pin in the repo
 * manifest (a prod dep would nest duplicate engine copies downstream); the
 * payload manifest promotes it into dependencies so `npm install --omit=dev`
 * in the payload root installs it.
 */
export function payloadManifest(pkg) {
	return {
		name: "torus-payload",
		version: pkg.version,
		private: true,
		type: "module",
		pi: pkg.pi,
		dependencies: {
			// mirror every runtime dependency — extensions import them directly
			// (e.g. @anthropic-ai/sandbox-runtime); a curated list drifts
			...pkg.dependencies,
			"@earendil-works/pi-coding-agent": pkg.devDependencies["@earendil-works/pi-coding-agent"],
		},
	};
}

/** Serialized payload package.json — byte-identical across all consumers. */
export function payloadPackageJson(pkg) {
	return `${JSON.stringify(payloadManifest(pkg), null, 2)}\n`;
}

/** Repo .npmrc contents, or null when absent (the launcher only writes it when present). */
export function payloadNpmrc() {
	try {
		return readFileSync(path.join(root, ".npmrc"), "utf8");
	} catch {
		return null;
	}
}

/** Repo package-lock.json contents, or null when absent (payload installs then float to latest-at-build). */
export function payloadPackageLock() {
	try {
		return readFileSync(path.join(root, "package-lock.json"), "utf8");
	} catch {
		return null;
	}
}
