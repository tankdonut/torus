import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAYLOAD_LOCK_ENV } from "../scripts/generate-payload-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "tamper-test");
const bin = path.join(outDir, "torus");
const home = path.join(outDir, "home-1");
const runtimeRoot = path.join(home, ".torus", "runtime");
const sampleFile = path.join(runtimeRoot, "extensions", "hashline", "index.ts");
const engineBin = path.join(root, "node_modules", ".bin", "pi");

// Source-mode spawns never reach the embedded extraction path, so this suite
// compiles the launcher once with bun. Without bun (or a bootstrapped
// worktree engine to point TORUS_PI_BIN at, keeping runs network-free) there
// is nothing to test.
const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8" });
let skipReason = null;
if (bunCheck.error || bunCheck.status !== 0) {
	skipReason = "bun is required to compile the launcher binary";
} else if (!existsSync(engineBin)) {
	skipReason =
		"worktree engine binary (node_modules/.bin/pi) is required so spawned runs stay offline";
}

if (!skipReason) {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	// fixture lock via the env override: the generator runs offline and the
	// embedded hash/lock stay self-consistent for this build
	const fixtureLock = path.join(outDir, "payload-lock.json");
	writeFileSync(
		fixtureLock,
		`${JSON.stringify(
			{
				name: "torus-payload",
				version: "0.0.0",
				lockfileVersion: 3,
				requires: true,
				packages: {
					"": { name: "torus-payload", version: "0.0.0", dependencies: { example: "1.0.0" } },
					"node_modules/example": {
						version: "1.0.0",
						resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
						integrity:
							"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);
	const gen = spawnSync("node", [path.join(root, "scripts", "generate-payload-assets.mjs")], {
		encoding: "utf8",
		env: { ...process.env, [PAYLOAD_LOCK_ENV]: fixtureLock },
	});
	assert.equal(gen.status, 0, `generate-payload-assets failed: ${gen.stderr}`);

	const build = spawnSync(
		"bun",
		["build", "--compile", path.join(root, "runtime", "bin", "torus.mjs"), "--outfile", bin],
		{ encoding: "utf8", cwd: root },
	);
	assert.equal(build.status, 0, `bun build --compile failed: ${build.stderr}`);
	chmodSync(bin, 0o755);
}

// Ambient TORUS_* exports from a running torus session must not leak in: the
// launcher resolves root/engine from them, so scrub before every spawn.
function runBinary() {
	const env = { ...process.env };
	for (const key of ["TORUS_ROOT", "TORUS_ENGINE", "TORUS_ENGINE_BIN", "TORUS_PI_BIN"]) {
		delete env[key];
	}
	env["HOME"] = home;
	env["TORUS_PI_BIN"] = engineBin;
	return spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 120000, env });
}

test("compiled binary extracts the embedded payload into a fresh HOME", {
	skip: skipReason || false,
}, () => {
	rmSync(home, { recursive: true, force: true });
	const run = runBinary();
	assert.equal(run.status, 0, `--version failed: ${run.stderr}`);
	assert.match(run.stdout, /^torus \d+\.\d+\.\d+/);
	assert.ok(run.stderr.includes("extracting embedded payload"), "first run reports extraction");
	for (const name of ["extensions", "agents", "skills", "package.json", ".payload-hash"]) {
		assert.ok(existsSync(path.join(runtimeRoot, name)), `${name} must be extracted`);
	}
});

test("tampered file under extensions/ is restored and the next run verifies clean", {
	skip: skipReason || false,
}, () => {
	const pristine = readFileSync(sampleFile);
	writeFileSync(sampleFile, "tampered");
	const run = runBinary();
	assert.equal(run.status, 0, `--version after tampering failed: ${run.stderr}`);
	assert.deepEqual(readFileSync(sampleFile), pristine, "tampered file must be restored");
	assert.ok(run.stderr.includes("restoring"), "the recovery must be named on stderr");

	const clean = runBinary();
	assert.equal(clean.status, 0, `clean rerun failed: ${clean.stderr}`);
	assert.ok(
		!clean.stderr.includes("extracting embedded payload") && !clean.stderr.includes("restoring"),
		"a verified root must start without re-extracting",
	);
});

test("deleted extensions/ top-level is restored", { skip: skipReason || false }, () => {
	const pristine = readFileSync(sampleFile);
	rmSync(path.join(runtimeRoot, "extensions"), { recursive: true, force: true });
	const run = runBinary();
	assert.equal(run.status, 0, `--version after deleting extensions/ failed: ${run.stderr}`);
	assert.deepEqual(readFileSync(sampleFile), pristine, "extensions/ must be re-extracted");
});

test("tampered package.json is restored", { skip: skipReason || false }, () => {
	const pkgPath = path.join(runtimeRoot, "package.json");
	const pristine = readFileSync(pkgPath);
	writeFileSync(pkgPath, '{"name":"tampered"}');
	const run = runBinary();
	assert.equal(run.status, 0, `--version after tampering package.json failed: ${run.stderr}`);
	assert.deepEqual(readFileSync(pkgPath), pristine, "package.json must be restored");
	assert.match(
		run.stdout,
		/^torus \d+\.\d+\.\d+/,
		"version line comes from the restored package.json",
	);
});
