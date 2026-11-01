import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { payloadLockPath } from "../scripts/generate-payload-lock.mjs";
import { payloadManifest } from "../scripts/payload-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const repoLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

// --- minimal semver range evaluation (exact, x-ranges, ^, ~, comparators, ||, hyphen).
// Returns true/false, or null when a specifier is not semver (git, url, tag) and
// cannot be judged here.

function parseVersion(v) {
	const parts = String(v).replace(/^v/, "").split("+")[0].split("-");
	const core = parts[0].split(".");
	return [Number(core[0]) || 0, Number(core[1]) || 0, Number(core[2]) || 0];
}

function compareVersions(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

function isWildcard(s) {
	return s === "*" || s === "x" || s === "X" || s === "";
}

function comparatorSatisfies(version, token) {
	if (isWildcard(token)) return true;
	const v = parseVersion(version);
	let op = "";
	let body = token;
	for (const candidate of [">=", "<=", ">", "<", "=", "^", "~"]) {
		if (token.startsWith(candidate)) {
			op = candidate;
			body = token.slice(candidate.length);
			break;
		}
	}
	body = body.replace(/^v/, "");
	if (isWildcard(body)) return true;
	if (!/^(\d+|[xX*])(\.(?!$)(\d+|[xX*])){0,2}$/.test(body)) return null;
	const parts = body.split(".");
	const wildcardAt = parts.findIndex((p) => isWildcard(p));
	// x-range ("1", "1.2", "1.x", "1.2.x"): >= specified prefix, < its next bump
	const prefixEnd = wildcardAt === -1 ? parts.length : wildcardAt;
	if (prefixEnd < 3) {
		const nums = parts.slice(0, prefixEnd).map(Number);
		const lower = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
		const upper = [...lower];
		upper[Math.max(nums.length - 1, 0)] += 1;
		return compareVersions(v, lower) >= 0 && compareVersions(v, upper) < 0;
	}
	const t = parseVersion(body);
	switch (op) {
		case "":
		case "=":
			return compareVersions(v, t) === 0;
		case ">":
			return compareVersions(v, t) > 0;
		case ">=":
			return compareVersions(v, t) >= 0;
		case "<":
			return compareVersions(v, t) < 0;
		case "<=":
			return compareVersions(v, t) <= 0;
		case "~":
			return compareVersions(v, t) >= 0 && compareVersions(v, [t[0], t[1] + 1, 0]) < 0;
		case "^": {
			const upper = t[0] > 0 ? [t[0] + 1, 0, 0] : t[1] > 0 ? [0, t[1] + 1, 0] : [0, 0, t[2] + 1];
			return compareVersions(v, t) >= 0 && compareVersions(v, upper) < 0;
		}
		default:
			return null;
	}
}

function satisfies(version, range) {
	if (typeof range !== "string") return null;
	const r = range.trim();
	if (r === "" || r === "*" || r === "latest") return true;
	if (
		/^[\w.-]+:/.test(r) ||
		r.includes("://") ||
		r.includes("#") ||
		/\s/.test(r.replace(/\s+-\s+/g, " - "))
	) {
		if (/^git\b|^https?:|^file:|^link:|^workspace:|^node:|^[\w.@/-]+@/.test(r)) return null;
	}
	let unknown = false;
	const ok = r.split("||").some((alternative) => {
		const alt = alternative.trim();
		if (alt === "") return true;
		const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
		const tokens = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : alt.split(/\s+/);
		let group = true;
		for (const token of tokens) {
			const verdict = comparatorSatisfies(version, token);
			if (verdict === null) {
				unknown = true;
				group = false;
			} else if (!verdict) {
				group = false;
			}
			if (!group) break;
		}
		return group;
	});
	if (ok) return true;
	return unknown ? null : false;
}

// --- payload-lock validation: every prod dep edge (manifest deps + their
// direct recorded edges, override-aware) must be satisfied by locked versions.

function overrideRange(overrides, parent, dep) {
	const scoped = overrides?.[parent];
	if (scoped !== null && typeof scoped === "object" && scoped[dep] !== undefined) {
		return scoped[dep];
	}
	if (typeof overrides?.[dep] === "string") {
		return overrides[dep];
	}
	return undefined;
}

function resolveInLock(lock, parentKey, dep) {
	const nestedKey = `${parentKey}/node_modules/${dep}`;
	if (lock.packages[nestedKey]) return lock.packages[nestedKey];
	return lock.packages[`node_modules/${dep}`];
}

function collectEdgeFailures(manifest, lock) {
	const failures = [];
	const rootEntry = lock.packages[""];
	const rootName = rootEntry?.name ?? lock.name;
	const rootVersion = rootEntry?.version ?? lock.version;
	if (rootName !== manifest.name)
		failures.push(`lock root name ${rootName} !== manifest ${manifest.name}`);
	if (rootVersion !== manifest.version) {
		failures.push(`lock root version ${rootVersion} !== manifest ${manifest.version}`);
	}

	for (const [name, declared] of Object.entries(manifest.dependencies)) {
		const parentKey = `node_modules/${name}`;
		const entry = lock.packages[parentKey];
		if (!entry) {
			failures.push(`${name}: declared ${declared} but not locked`);
			continue;
		}
		if (entry.dev) failures.push(`${name}: locked as dev-only`);
		const verdict = satisfies(entry.version, declared);
		if (verdict === false) failures.push(`${name}@${entry.version} does not satisfy ${declared}`);

		const edges = { ...entry.dependencies, ...entry.optionalDependencies };
		for (const [dep, recorded] of Object.entries(edges)) {
			const effective = overrideRange(manifest.overrides, name, dep) ?? recorded;
			const resolved = resolveInLock(lock, parentKey, dep);
			if (!resolved) {
				if (entry.optionalDependencies?.[dep] === undefined) {
					failures.push(`${name} -> ${dep} (${recorded}): no locked resolution`);
				}
				continue;
			}
			const edgeVerdict = satisfies(resolved.version, effective);
			if (edgeVerdict === false) {
				const note = effective === recorded ? "" : ` (override ${effective}, declared ${recorded})`;
				failures.push(`${name} -> ${dep}@${resolved.version} does not satisfy ${effective}${note}`);
			}
		}
	}
	return failures;
}

// --- tests

test("payload manifest carries the repo overrides", () => {
	assert.deepEqual(payloadManifest(pkg).overrides, pkg.overrides);
});

test("generated payload lock matches the manifest and pins repo resolutions", (t) => {
	const lockPath = payloadLockPath();
	let lockText;
	try {
		lockText = readFileSync(lockPath, "utf8");
	} catch {
		t.skip(`no generated payload lock at ${lockPath} — run scripts/generate-payload-lock.mjs`);
		return;
	}
	const lock = JSON.parse(lockText);
	const manifest = payloadManifest(pkg);
	if (lock.version !== manifest.version) {
		t.skip(
			`payload lock at ${lockPath} predates ${manifest.version} (holds ${lock.version}) — regenerate with scripts/generate-payload-lock.mjs`,
		);
		return;
	}

	assert.equal(lock.name, manifest.name, "generated lock root name must be the payload's");
	assert.equal(lock.version, manifest.version, "generated lock root version must be the payload's");
	assert.deepEqual(
		lock.packages[""].dependencies,
		manifest.dependencies,
		"lock root entry must mirror the manifest deps (engine promoted)",
	);

	const failures = collectEdgeFailures(manifest, lock);
	assert.deepEqual(
		failures,
		[],
		`generated lock must satisfy every prod dep edge:\n${failures.join("\n")}`,
	);

	// override-forced resolutions must equal the repo lock's, read from the
	// repo lock (never hardcoded)
	for (const dep of ["zod", "undici"]) {
		const payloadEntry = lock.packages[`node_modules/${dep}`];
		const repoEntry = repoLock.packages[`node_modules/${dep}`];
		assert.ok(payloadEntry, `${dep} must be locked in the payload lock`);
		assert.ok(repoEntry, `${dep} must be locked in the repo lock`);
		assert.equal(payloadEntry.dev, undefined, `${dep} must be non-dev in the payload lock`);
		assert.equal(
			payloadEntry.version,
			repoEntry.version,
			`${dep} resolution must equal the repo lock's (${repoEntry.version})`,
		);
	}
});

test("edge validation catches override-forced edges when overrides are dropped", () => {
	// scratch synthesis: the manifest exactly as it was before overrides were
	// carried, paired with a lock that otherwise looks payload-native (root
	// rewritten, engine de-devved) — isolates the missing-override failures
	const scratchManifest = payloadManifest(pkg);
	delete scratchManifest.overrides;
	const scratchLock = structuredClone(repoLock);
	scratchLock.name = scratchManifest.name;
	scratchLock.version = scratchManifest.version;
	scratchLock.packages[""] = {
		name: scratchManifest.name,
		version: scratchManifest.version,
		private: true,
		dependencies: scratchManifest.dependencies,
	};
	delete scratchLock.packages["node_modules/@earendil-works/pi-coding-agent"].dev;

	const failures = collectEdgeFailures(scratchManifest, scratchLock);

	const scopedOverrides = Object.entries(pkg.overrides ?? {}).filter(
		([, value]) => value !== null && typeof value === "object",
	);
	assert.ok(
		scopedOverrides.length > 0,
		"repo must keep scoped overrides for this regression check",
	);
	for (const [parent, map] of scopedOverrides) {
		for (const dep of Object.keys(map)) {
			assert.ok(
				failures.some((f) => f.startsWith(`${parent} -> ${dep}@`)),
				`dropping overrides must flag ${parent} -> ${dep}; got:\n${failures.join("\n")}`,
			);
		}
	}
});
