import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

/** Marker file inside a payload root recording the hash of the extracted payload. */
export const MARKER_NAME = ".payload-hash";

/**
 * Stable, order-independent digest over payload entries ({ path, bytes }).
 * Computed at build time by the asset generator and recomputed at startup by
 * verifyExtracted over the extracted root; a mismatch re-extracts the payload.
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

/**
 * Payload content hash from the marker (line 1 only; the deps-hash on line 2
 * is read via readMarkerDeps), or null when absent or unreadable.
 */
export function readMarker(root) {
	try {
		return readFileSync(path.join(root, MARKER_NAME), "utf8").split("\n", 1)[0].trim();
	} catch {
		return null;
	}
}

/**
 * Dependency-manifest hash from the marker's second line, or null when the
 * marker is absent, legacy single-line, or unreadable.
 */
export function readMarkerDeps(root) {
	try {
		const deps = readFileSync(path.join(root, MARKER_NAME), "utf8").split("\n")[1]?.trim();
		return deps ? deps : null;
	} catch {
		return null;
	}
}

/**
 * The launcher's npm-install decision for a payload root: an existing engine
 * binary is reused as-is unless this run re-extracted the payload, in which
 * case only a matching deps-hash (dependency manifest unchanged) avoids the
 * reinstall.
 */
export function shouldSkipInstall(root, localBin, refreshed, embeddedDepsHash) {
	if (!existsSync(localBin)) return false;
	if (!refreshed) return true;
	return embeddedDepsHash != null && readMarkerDeps(root) === embeddedDepsHash;
}

const ROOT_FILES = ["package.json", ".npmrc", "package-lock.json"];

function walkDir(root, rel, out) {
	for (const name of readdirSync(path.join(root, rel)).sort()) {
		const relPath = rel ? `${rel}/${name}` : name;
		const abs = path.join(root, relPath);
		if (statSync(abs).isDirectory()) {
			walkDir(root, relPath, out);
		} else {
			out.push({ path: relPath, bytes: readFileSync(abs) });
		}
	}
	return out;
}

/**
 * Whether the extracted root still matches the build-time payload hash. The
 * entry set mirrors the generator: every file under the owned top-levels plus
 * the root files, with absent root files hashing as empty bytes (the
 * generator's null handling). node_modules stays outside the set — the
 * marker's deps line guards it separately. Unreadable content counts as a
 * mismatch so the caller can self-heal by re-extracting.
 */
export function verifyExtracted(root, expectedHash, ownedTopLevels) {
	try {
		const entries = [];
		for (const name of ownedTopLevels) {
			if (existsSync(path.join(root, name))) walkDir(root, name, entries);
		}
		for (const name of ROOT_FILES) {
			let bytes = Buffer.alloc(0);
			try {
				bytes = readFileSync(path.join(root, name));
			} catch {
				// absent root files hash as empty, like the generator
			}
			entries.push({ path: name, bytes });
		}
		return computePayloadHash(entries) === expectedHash;
	} catch {
		return false;
	}
}

/**
 * Materialize payload files under root. Owned top-level entries are wiped
 * first so stale files from older payloads cannot survive; everything else in
 * root — notably node_modules holding the bootstrapped engine — is preserved.
 * The marker is written last so an interrupted extraction retries: line 1 is
 * the payload content hash and, when depsHash is given, line 2 records the
 * dependency-manifest hash so unchanged deps can skip the engine reinstall
 * after a payload refresh.
 */
export function extractPayload(root, hash, ownedTopLevels, files, depsHash) {
	for (const name of ownedTopLevels) {
		rmSync(path.join(root, name), { recursive: true, force: true });
	}
	for (const file of files) {
		const dest = path.join(root, file.path);
		mkdirSync(path.dirname(dest), { recursive: true });
		writeFileSync(dest, file.bytes);
	}
	writeFileSync(path.join(root, MARKER_NAME), depsHash ? `${hash}\n${depsHash}\n` : `${hash}\n`);
	return files.length;
}
