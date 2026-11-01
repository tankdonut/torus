#!/usr/bin/env node
/**
 * Emits a CycloneDX SBOM from a package-lock.json — default the generated
 * payload lock, so the inventory describes exactly the dependency tree the
 * binary ships. Lock-driven by design: no install, no network, and workspace
 * link entries (which carry no version) are skipped rather than fatal.
 *
 * Usage: node scripts/generate-sbom.mjs [lockPath] [outPath]
 */
import { readFileSync, writeFileSync } from "node:fs";

const lockPath = process.argv[2] ?? "dist/payload-lock.json";
const outPath = process.argv[3] ?? "dist/stage/torus-sbom.cdx.json";

const lock = JSON.parse(readFileSync(lockPath, "utf8"));

const components = [];
for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
	if (pkgPath === "" || meta.link || !meta.version) continue;
	const name = meta.name ?? pkgPath.replace(/^node_modules\//, "");
	const component = {
		type: "library",
		"bom-ref": `pkg:npm/${name}@${meta.version}`,
		name,
		version: meta.version,
		purl: `pkg:npm/${name}@${meta.version}`,
	};
	const integrity = typeof meta.integrity === "string" ? meta.integrity.split("-")[1] : undefined;
	if (integrity) {
		component.hashes = [{ alg: "SHA-512", content: integrity }];
	}
	components.push(component);
}

const sbom = {
	bomFormat: "CycloneDX",
	specVersion: "1.5",
	version: 1,
	metadata: {
		component: {
			type: "application",
			name: lock.name ?? "torus-payload",
			version: lock.version ?? "0.0.0",
		},
	},
	components,
};

writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`);
process.stderr.write(`sbom: ${components.length} components from ${lockPath} -> ${outPath}\n`);
