import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Static drift guards (always on, no docker) + docker-gated dynamic smokes for
// the torus container image. Dynamic tests only run under
// `TORUS_CONTAINER_TESTS=1` (what ./make.sh image-test sets); they probe an
// already-built image and never build one.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const toolVersions = readFileSync(path.join(root, ".tool-versions"), "utf8");
const dockerignore = readFileSync(path.join(root, ".dockerignore"), "utf8");
const ciWorkflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const makeSh = readFileSync(path.join(root, "make.sh"), "utf8");

function dockerfileArg(name) {
	const match = dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, "m"));
	return match?.[1];
}

function toolPin(plugin) {
	const match = toolVersions.match(new RegExp(`^${plugin} (\\S+)$`, "m"));
	return match?.[1];
}

const nodePin = toolPin("nodejs");
const astGrepPin = dockerfileArg("AST_GREP_VERSION");

test("container: node/bun versions come from .tool-versions, not Dockerfile defaults", () => {
	for (const [argName, plugin] of [
		["NODE_VERSION", "nodejs"],
		["BUN_VERSION", "bun"],
	]) {
		const pin = toolPin(plugin);
		assert.ok(pin, `.tool-versions must contain a ${plugin} pin`);
		assert.ok(
			new RegExp(`^ARG ${argName}$`, "m").test(dockerfile),
			`Dockerfile must declare bare ARG ${argName} — ${plugin} is pinned in .tool-versions, not defaulted`,
		);
		assert.ok(
			makeSh.includes(`${argName}="$(awk '$1=="${plugin}"{print $2}' .tool-versions)"`),
			`./make.sh image must resolve ${argName} from .tool-versions (${plugin})`,
		);
		assert.ok(
			makeSh.includes(`--build-arg ${argName}="$${argName}"`),
			`./make.sh image must pass ${argName} as a docker build-arg`,
		);
	}
});

test("container: every Dockerfile FROM pins a version (no :latest, no bare image)", () => {
	const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
	assert.ok(froms.length > 0, "no FROM lines found in Dockerfile");
	for (const image of froms) {
		const colon = image.lastIndexOf(":");
		assert.ok(colon !== -1, `FROM ${image} must pin an explicit tag`);
		const tag = image.slice(colon + 1);
		assert.notEqual(tag.toLowerCase(), "latest", `FROM ${image} must not float on :latest`);
		for (const arg of [...tag.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1])) {
			if (dockerfileArg(arg) !== undefined) continue;
			assert.ok(
				makeSh.includes(`--build-arg ${arg}=`),
				`FROM ${image} uses ARG ${arg} which has no default and no make.sh image --build-arg`,
			);
		}
	}
});

test("container: runtime-stage apt install ships every agent runtime dep", () => {
	const froms = [...dockerfile.matchAll(/^FROM\s+\S+/gm)];
	const runtimeStage = dockerfile.slice(froms.at(-1).index);
	const lines = runtimeStage.split("\n");
	const start = lines.findIndex((line) => line.includes("apt-get install -y"));
	assert.ok(start !== -1, "runtime stage has no apt-get install line");
	let end = start + 1;
	while (end < lines.length && lines[end - 1].endsWith("\\")) end++;
	const aptText = lines.slice(start, end).join("\n");
	for (const pkg of [
		"tmux",
		"bubblewrap",
		"socat",
		"git",
		"ripgrep",
		"libnotify-bin",
		"ca-certificates",
	]) {
		assert.ok(
			new RegExp(`\\b${pkg}\\b`).test(aptText),
			`runtime apt install is missing package: ${pkg}`,
		);
	}
});

test("container: Dockerfile keeps torus entrypoint, non-root user, npmrc-before-build", () => {
	assert.ok(
		dockerfile.includes('ENTRYPOINT ["torus"]'),
		'Dockerfile must keep ENTRYPOINT ["torus"]',
	);
	assert.ok(/^USER torus$/m.test(dockerfile), "Dockerfile must set USER torus");
	const npmrcAt = dockerfile.indexOf("./make.sh npmrc");
	const buildAt = dockerfile.indexOf("./scripts/build-binary.sh");
	assert.ok(
		npmrcAt !== -1 && buildAt !== -1 && npmrcAt < buildAt,
		"Dockerfile must run ./make.sh npmrc before ./scripts/build-binary.sh",
	);
});

test("container: .dockerignore excludes .git, node_modules, dist", () => {
	const entries = new Set(dockerignore.split("\n").map((line) => line.trim()));
	for (const entry of [".git", "node_modules", "dist"]) {
		assert.ok(entries.has(entry), `.dockerignore must list ${entry}`);
	}
});

test("container: image bakes payload deps — no first-run npm bootstrap", () => {
	const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
	assert.ok(
		runtimeStage.includes("COPY --from=build --chown=torus:torus /out/torus /opt/torus"),
		"runtime stage must ship the baked payload tree (node_modules incl. engine) at /opt/torus",
	);
	assert.ok(
		/^ENV TORUS_ROOT=\/opt\/torus$/m.test(dockerfile),
		"Dockerfile must set ENV TORUS_ROOT=/opt/torus so the launcher skips extraction + bootstrap",
	);
	const bakeAt = dockerfile.indexOf("scripts/bake-payload.mjs");
	const installAt = dockerfile.indexOf(
		"npm install --no-fund --no-audit --omit=dev --legacy-peer-deps",
	);
	assert.ok(
		bakeAt !== -1 && installAt !== -1 && bakeAt < installAt,
		"build stage must bake the payload tree before npm-installing into it",
	);
	// the bake installs with the same flags as the launcher bootstrap, so the
	// baked tree matches what a network bootstrapped ~/.torus/runtime would hold
	const installCmd = dockerfile.slice(installAt, installAt + 120);
	for (const flag of ["--omit=dev", "--legacy-peer-deps"]) {
		assert.ok(installCmd.includes(flag), `bake npm install must keep ${flag}`);
	}
});

test("container: ci.yml builds each platform once, tests the pushed digest, merges multi-arch after tests", () => {
	assert.ok(
		/^ {2}container:$/m.test(ciWorkflow),
		"ci.yml must define a container: job (2-space indent)",
	);
	// PR path: one loaded amd64 image feeds the suite — no registry push, no arm64.
	assert.ok(
		/platforms: linux\/amd64\n\s+load: true/.test(ciWorkflow),
		"PR test image must be built via buildx with load:true on linux/amd64",
	);
	assert.ok(
		ciWorkflow.includes("tags: torus:ci"),
		"loaded test image must be tagged torus:ci for image-test",
	);
	assert.ok(
		ciWorkflow.includes("./make.sh image-test torus:ci"),
		"container job must run the container suite via ./make.sh image-test torus:ci",
	);
	// Publish path: the build pushes unnamed by digest, and the suite runs
	// against that exact digest pulled back from the registry — the tested
	// image IS the published object. (Multi-output type=docker+push-by-digest
	// silently skips the push: docker/build-push-action#1318.)
	assert.ok(
		ciWorkflow.includes(
			"outputs: type=image,name=ghcr.io/tankdonut/torus,push-by-digest=true,push=true",
		),
		"amd64 publish build must push by digest (tagged only by container-publish, after tests)",
	);
	assert.ok(
		/docker pull "ghcr\.io\/tankdonut\/torus@\$\{\{ steps\.build\.outputs\.digest \}\}"/.test(
			ciWorkflow,
		),
		"test suite must run against the pulled-back pushed digest, not a rebuilt image",
	);
	assert.ok(
		(ciWorkflow.match(/provenance: mode=max/g) ?? []).length >= 2,
		"both platform builds must attach provenance attestations",
	);
	// arm64: separate native-runner job, gated to main/tags, pushes by digest.
	assert.ok(/^ {2}container-arm64:$/m.test(ciWorkflow), "ci.yml must define a container-arm64 job");
	const arm64Gate = /container-arm64:\n[\s\S]*?\n {4}if: ([^\n]+)/.exec(ciWorkflow)?.[1] ?? "";
	assert.ok(
		arm64Gate.includes("refs/heads/main") && arm64Gate.includes("refs/tags/v"),
		"arm64 build must be gated to main/tags only",
	);
	assert.ok(
		/container-arm64:[\s\S]*?runs-on: ubuntu-24\.04-arm/.test(ciWorkflow),
		"arm64 build must run on a native arm64 runner (no QEMU)",
	);
	assert.ok(ciWorkflow.includes("platforms: linux/arm64"), "arm64 job must build linux/arm64");
	// Merge: multi-arch tags assembled from the two digests, only after both
	// platform jobs (including the tested amd64 build) succeeded.
	assert.ok(
		/^ {2}container-publish:$/m.test(ciWorkflow),
		"ci.yml must define a container-publish job",
	);
	assert.ok(
		/container-publish:\n[\s\S]*?\n {4}needs: \[container, container-arm64\]/.test(ciWorkflow),
		"publish job must gate on both platform jobs",
	);
	assert.ok(
		ciWorkflow.includes("docker buildx imagetools create"),
		"multi-arch tags must be assembled via imagetools create",
	);
	assert.ok(
		ciWorkflow.includes("needs.container.outputs.amd64_digest") &&
			ciWorkflow.includes("needs.container-arm64.outputs.arm64_digest"),
		"merge must reference the digests pushed by the platform jobs",
	);
	assert.ok(
		ciWorkflow.includes("type=raw,value=latest,enable={{is_default_branch}}"),
		"latest must stay on the default branch (docs/container.md tag policy)",
	);
	assert.ok(
		/release:\n[\s\S]*?\n {4}needs: \[lint-typecheck, smoke, build, container-publish\]/.test(
			ciWorkflow,
		),
		"release must gate on container-publish (transitively: tests + both platforms)",
	);
	// Cache: scopes split per arch so parallel platform builds never race the
	// same GHA cache record, while shared layers still cross-hit.
	assert.ok(
		ciWorkflow.includes("cache-to: type=gha,mode=max,scope=torus-amd64") &&
			ciWorkflow.includes("cache-to: type=gha,mode=max,scope=torus-arm64"),
		"each platform build must export its own GHA cache scope",
	);
	assert.ok(
		/cache-from:[^\n]*\n\s+type=gha,scope=torus-amd64\n\s+type=gha,scope=torus-arm64/.test(
			ciWorkflow,
		),
		"platform builds must read both GHA cache scopes",
	);
	for (const arg of ["NODE_VERSION", "BUN_VERSION"]) {
		assert.ok(
			ciWorkflow.includes(`${arg}=$(awk`),
			`container jobs must resolve ${arg} from .tool-versions for the build args`,
		);
		assert.ok(
			new RegExp(`build-args:[\\s\\S]*?${arg}=\\$\\{\\{ env\\.${arg} \\}}`).test(ciWorkflow),
			`platform builds must pass ${arg} build-arg (Dockerfile declares no default)`,
		);
	}
});

const GATED = process.env.TORUS_CONTAINER_TESTS === "1";
const IMAGE = process.env.TORUS_IMAGE ?? "torus:dev";

function dockerRun(args, timeoutMs) {
	return spawnSync("docker", args, {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 16 * 1024 * 1024,
	});
}

// The podman docker shim prepends an "Emulate Docker CLI" banner to stdout and
// emits CRLF line endings — normalize both before asserting on command output.
function stdoutOf(result) {
	return (result.stdout ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter((line) => !line.startsWith("Emulate Docker CLI"))
		.join("\n")
		.trim();
}

function describeResult(result) {
	return `status=${result.status} signal=${result.signal ?? ""} stdout=${stdoutOf(result)} stderr=${(result.stderr ?? "").trim()}`;
}

function gated(t) {
	if (!GATED) {
		t.skip("docker-gated: run via ./make.sh image-test (TORUS_CONTAINER_TESTS=1)");
		return false;
	}
	const info = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 30_000 });
	if (info.status !== 0) {
		t.skip("docker-gated: docker daemon unavailable");
		return false;
	}
	return true;
}

let imageVerified = false;
function requireImage() {
	if (imageVerified) return;
	const inspect = dockerRun(["image", "inspect", IMAGE], 30_000);
	if (inspect.status !== 0) {
		assert.fail(
			`image ${IMAGE} not found — run ./make.sh image first (${describeResult(inspect)})`,
		);
	}
	imageVerified = true;
}

test("container: default entrypoint boots the engine (docker-gated)", (t) => {
	if (!gated(t)) return;
	requireImage();
	// No --entrypoint override here: this is the one probe exercising the
	// image default. The payload + engine are baked into the image
	// (TORUS_ROOT=/opt/torus), so boot does no extraction and no npm install.
	// Keyless "No models available" on stdout is success (exit 0).
	const run = dockerRun(["run", "--rm", IMAGE, "--list-models"], 240_000);
	assert.equal(run.status, 0, `torus --list-models failed: ${describeResult(run)}`);
});

test("container: engine boots fully offline — deps baked, no first-run npm install (docker-gated)", (t) => {
	if (!gated(t)) return;
	requireImage();
	// The image ships the payload + engine node_modules at /opt/torus and
	// points the launcher there via TORUS_ROOT; with networking disabled
	// nothing can be downloaded, so a clean boot proves the bake.
	const run = dockerRun(["run", "--rm", "--network", "none", IMAGE, "--list-models"], 120_000);
	assert.equal(run.status, 0, `offline torus --list-models failed: ${describeResult(run)}`);
});

test("container: node runtime matches .tool-versions pin (docker-gated)", (t) => {
	if (!gated(t)) return;
	requireImage();
	const run = dockerRun(["run", "--rm", "--entrypoint", "node", IMAGE, "--version"], 60_000);
	assert.equal(run.status, 0, `node --version failed: ${describeResult(run)}`);
	assert.ok(
		stdoutOf(run).startsWith("v"),
		`node --version should print v<pin>: ${describeResult(run)}`,
	);
	assert.equal(
		stdoutOf(run),
		`v${nodePin}`,
		`container node version drifted from .tool-versions nodejs ${nodePin}`,
	);
});

test("container: tool inventory pinned/complete (docker-gated)", (t) => {
	if (!gated(t)) return;
	requireImage();
	const script = `set -u
tmux -V
bwrap --version
socat -V 2>&1 | head -n 2
git --version
rg --version | head -n 1
ast-grep --version
for c in typescript-language-server notify-send script which bash sg; do
	if command -v "$c" >/dev/null 2>&1; then echo "found $c"; else echo "MISSING $c"; fi
done`;
	const run = dockerRun(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", script], 120_000);
	assert.equal(run.status, 0, `tool inventory probe failed: ${describeResult(run)}`);
	const out = stdoutOf(run);
	assert.ok(out.includes("tmux 3"), `tmux: expected a tmux 3.x version, got: ${out}`);
	assert.ok(out.includes("bubblewrap 0"), `bwrap: expected a bubblewrap 0.x version, got: ${out}`);
	assert.ok(out.includes("socat version"), `socat: expected a "socat version" banner, got: ${out}`);
	assert.ok(out.includes("git version"), `git: expected a "git version" line, got: ${out}`);
	assert.ok(out.includes("ripgrep"), `rg: expected a ripgrep banner, got: ${out}`);
	assert.ok(
		out.includes(`ast-grep ${astGrepPin}`),
		`ast-grep: version must match Dockerfile pin ${astGrepPin}, got: ${out}`,
	);
	for (const bin of [
		"typescript-language-server",
		"notify-send",
		"script",
		"which",
		"bash",
		"sg",
	]) {
		assert.ok(new RegExp(`found ${bin}(\\n|$)`).test(out), `${bin}: not found in container PATH`);
	}
});

test("container: tmux can run headless sessions (docker-gated)", (t) => {
	if (!gated(t)) return;
	requireImage();
	const run = dockerRun(
		[
			"run",
			"--rm",
			"--entrypoint",
			"sh",
			IMAGE,
			"-c",
			"tmux new-session -d -s citest && tmux ls && tmux kill-server",
		],
		60_000,
	);
	assert.equal(run.status, 0, `tmux headless smoke failed: ${describeResult(run)}`);
});

test("container: non-root user with writable torus home (docker-gated)", (t) => {
	if (!gated(t)) return;
	requireImage();
	const uid = dockerRun(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"], 60_000);
	assert.equal(uid.status, 0, `id -u failed: ${describeResult(uid)}`);
	assert.equal(stdoutOf(uid), "1000", "container must run as non-root uid 1000 (USER torus)");
	const write = dockerRun(
		[
			"run",
			"--rm",
			"--entrypoint",
			"sh",
			IMAGE,
			"-c",
			"mkdir -p ~/.torus && touch ~/.torus/.probe && rm ~/.torus/.probe",
		],
		60_000,
	);
	assert.equal(write.status, 0, `~/.torus must be writable: ${describeResult(write)}`);
});
