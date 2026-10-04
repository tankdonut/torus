import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Marker file inside a payload root recording the hash of the extracted payload. */
export const MARKER_NAME = ".payload-hash";

/**
 * Stable, order-independent digest over payload entries ({ path, bytes }).
 * Computed at build time by the asset generator; the runtime trusts the marker
 * written after a successful extraction instead of recomputing.
 */
export function computePayloadHash(entries) {
	const hash = createHash("sha256");
	for (const entry of [...entries].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	)) {
		hash.update(entry.path);
		hash.update("\0");
		hash.update(entry.bytes);
	}
	return hash.digest("hex");
}

/** Marker value inside root, or null when absent or unreadable. */
export function readMarker(root) {
	try {
		return readFileSync(path.join(root, MARKER_NAME), "utf8").trim();
	} catch {
		return null;
	}
}

/**
 * Materialize payload files under root. Owned top-level entries are wiped
 * first so stale files from older payloads cannot survive; everything else in
 * root — notably node_modules holding the bootstrapped engine — is preserved.
 * The hash marker is written last so an interrupted extraction retries.
 */
export function extractPayload(root, hash, ownedTopLevels, files) {
	for (const name of ownedTopLevels) {
		rmSync(path.join(root, name), { recursive: true, force: true });
	}
	for (const file of files) {
		const dest = path.join(root, file.path);
		mkdirSync(path.dirname(dest), { recursive: true });
		writeFileSync(dest, file.bytes);
	}
	writeFileSync(path.join(root, MARKER_NAME), `${hash}\n`);
	return files.length;
}
