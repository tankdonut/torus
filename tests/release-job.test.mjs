import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciWorkflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

test("audit job: blocking dependency scan on every push and PR", () => {
	assert.ok(/^ {2}audit:$/m.test(ciWorkflow), "ci.yml must define an audit job");
	assert.ok(
		ciWorkflow.includes("npm audit --audit-level=high"),
		"audit job must run a blocking npm audit at high severity",
	);
});

test("release job: attests checksums and SBOM, ships attestation bundles", () => {
	assert.ok(
		ciWorkflow.includes(
			"node scripts/generate-sbom.mjs dist/payload-lock.json dist/stage/torus-sbom.cdx.json",
		),
		"release job must generate the SBOM from the payload lock into the staged assets",
	);
	const subjectAt = ciWorkflow.indexOf("subject-path:");
	const subjectBlock = ciWorkflow.slice(subjectAt, subjectAt + 200);
	assert.ok(
		subjectBlock.includes("dist/stage/torus-*") &&
			subjectBlock.includes("dist/stage/sha256sums.txt"),
		"provenance subjects must cover the binaries and the checksum file",
	);
	assert.ok(
		ciWorkflow.includes('cd "$stage"'),
		"the bundle loop must cd into the stage dir so torus-* expands against the staged files",
	);
	assert.ok(
		ciWorkflow.includes('gh attestation download "$stage/$name"'),
		"the bundle loop must pass absolute staged paths to gh",
	);
	assert.ok(
		ciWorkflow.includes(".intoto.jsonl"),
		"attestation bundles must land as .intoto.jsonl release assets",
	);
});

test("release job: tag-gated, gated on every job, staged outside the artifact tree", () => {
	assert.ok(/^ {2}release:$/m.test(ciWorkflow), "ci.yml must define a release: job");
	assert.ok(
		/^ {2}workflow_dispatch:$/m.test(ciWorkflow),
		"ci.yml must accept workflow_dispatch (token-created tags do not fire on:push)",
	);
	assert.ok(
		ciWorkflow.includes("if: startsWith(github.ref, 'refs/tags/v')"),
		"release job must be gated to v* tag refs",
	);
	assert.ok(
		ciWorkflow.includes("needs: [audit, lint-typecheck, smoke, build, container-publish]"),
		"release job must depend on every gate job incl. the dependency audit",
	);
	assert.ok(
		ciWorkflow.includes("attestations: write"),
		"release job must hold attestation permissions",
	);
	assert.ok(
		ciWorkflow.includes("gh release upload"),
		"release job must attach assets to the existing release",
	);
	assert.ok(
		ciWorkflow.includes("attest-build-provenance"),
		"release job must attest build provenance",
	);
	assert.ok(
		!ciWorkflow.includes("dist/release/torus-"),
		"staged binaries must not be read from inside the artifact tree (artifact dirs collide with staged names)",
	);
});

// The staging step's run: block is the contract — execute it verbatim against a
// five-artifact fixture instead of re-implementing (and drifting from) the loop.
function stagingStepScript() {
	const marker = "- name: Stage, checksum, and verify version consistency";
	const at = ciWorkflow.indexOf(marker);
	assert.ok(at >= 0, "staging step must exist in ci.yml");
	const lines = ciWorkflow.slice(at).split("\n");
	const runAt = lines.findIndex((line) => line.trim() === "run: |");
	assert.ok(runAt > 0, "staging step must use a literal run block");
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.startsWith(" ".repeat(10)) || line.trim() === "") {
			body.push(line.replace(/^ {10}/, ""));
		} else {
			break;
		}
	}
	return `${body.join("\n").trimEnd()}\n`;
}

function buildFixture(dir, refName) {
	const targets = [
		["torus-linux-x64", "torus"],
		["torus-linux-arm64", "torus"],
		["torus-darwin-x64", "torus"],
		["torus-darwin-arm64", "torus"],
		["torus-windows-x64", "torus.exe"],
	];
	for (const [name, bin] of targets) {
		mkdirSync(path.join(dir, "dist", "release", name, "bin"), { recursive: true });
		const binPath = path.join(dir, "dist", "release", name, "bin", bin);
		writeFileSync(binPath, "#!/usr/bin/env bash\necho 'torus 0.3.0 (pi@1.0.2)'\n");
		// artifact downloads come back 0644 — the workflow must restore exec bits itself
		chmodSync(binPath, 0o644);
	}
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }, null, 2));
	return { env: { ...process.env, GITHUB_REF_NAME: refName } };
}

test("release job: staging step stages, checksums, and passes a consistent version", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-release-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { env } = buildFixture(dir, "v0.3.0");

	const run = spawnSync("bash", ["-c", stagingStepScript()], { cwd: dir, encoding: "utf8", env });
	assert.equal(run.status, 0, `staging step failed:\n${run.stderr}`);

	const staged = readdirSync(path.join(dir, "dist", "stage")).sort();
	assert.deepEqual(
		staged,
		[
			"sha256sums.txt",
			"torus-darwin-arm64",
			"torus-darwin-x64",
			"torus-linux-arm64",
			"torus-linux-x64",
			"torus-windows-x64.exe",
		],
		"staging must flatten the five artifacts to uniquely named files",
	);
	const sums = readFileSync(path.join(dir, "dist", "stage", "sha256sums.txt"), "utf8")
		.trim()
		.split("\n");
	assert.equal(sums.length, 5, "sha256sums.txt must cover exactly the five binaries");

	for (const bin of ["torus-linux-x64", "torus-darwin-arm64"]) {
		accessSync(path.join(dir, "dist", "stage", bin), constants.X_OK);
	}
	assert.ok(true, "staged binaries must be executable — artifact download strips the bit");
});

test("build job: fresh-home smoke bootstraps once and checks locked versions", () => {
	const marker = "- name: Fresh-home determinism smoke (x64 Linux)";
	const at = ciWorkflow.indexOf(marker);
	assert.ok(at >= 0, "build job must contain the fresh-home determinism smoke step");
	const end = ciWorkflow.indexOf("- uses: actions/upload-artifact", at);
	assert.ok(end > at, "smoke step must stay inside the build job's steps");
	const step = ciWorkflow.slice(at, end);
	assert.ok(
		(step.match(/dist\/torus\/bin\/torus --version/g) ?? []).length === 2,
		"smoke must run --version twice: extract once, then prove no reinstall",
	);
	assert.ok(
		step.includes("grep -q 'extracting the bundled engine tree'"),
		"first run must assert the offline tree extraction on stderr",
	);
	assert.ok(step.includes("! grep -q 'npm '"), "first run must assert npm is never invoked");
	assert.ok(
		step.includes("second run must not reinstall"),
		"second run must assert the absence of a bootstrap line",
	);
	assert.ok(
		step.includes("for dep in zod undici '@earendil-works/pi-coding-agent'"),
		"smoke must compare installed zod, undici, and engine versions",
	);
	assert.ok(
		step.includes("require('$RT/node_modules/$1/package.json').version"),
		"installed versions must be read from the fresh runtime's node_modules",
	);
	assert.ok(
		step.includes("dist/payload-lock.json"),
		"version comparison must use the built payload lock when it exists",
	);
});

test("release job: staging step fails on tag/package/binary version skew", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-release-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { env } = buildFixture(dir, "v0.2.0");

	const run = spawnSync("bash", ["-c", stagingStepScript()], { cwd: dir, encoding: "utf8", env });
	assert.notEqual(
		run.status,
		0,
		"version skew (tag v0.2.0 vs pkg/bin 0.3.0) must fail the release step",
	);
	assert.match(
		run.stdout,
		/tag=0\.2\.0 pkg=0\.3\.0 bin=0\.3\.0/,
		"failure output must name all three versions",
	);
});

test("package-channel job: the git-install channel installs without dev dependencies", () => {
	assert.ok(/^ {2}package-channel:$/m.test(ciWorkflow), "ci.yml must define a package-channel job");
	assert.ok(
		ciWorkflow.includes("npm install --omit=dev --legacy-peer-deps"),
		"package-channel must run the exact install command pi's git-install uses",
	);
	assert.ok(
		ciWorkflow.includes("test ! -e node_modules/husky"),
		"package-channel must prove husky stays absent from the consumer install",
	);
});
