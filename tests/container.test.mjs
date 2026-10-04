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

test("container: Dockerfile ARG pins match .tool-versions (node, bun)", () => {
	for (const [argName, plugin] of [
		["NODE_VERSION", "nodejs"],
		["BUN_VERSION", "bun"],
	]) {
		const pin = toolPin(plugin);
		assert.ok(pin, `.tool-versions must contain a ${plugin} pin`);
		assert.equal(
			dockerfileArg(argName),
			pin,
			`Dockerfile ARG ${argName} drifted from .tool-versions (${plugin} ${pin ?? "?"})`,
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
			assert.ok(
				dockerfileArg(arg) !== undefined,
				`FROM ${image} uses ARG ${arg} which has no default value`,
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

test("container: ci.yml container job builds, tests, and publishes multi-arch (ref-gated)", () => {
	assert.ok(
		/^ {2}container:$/m.test(ciWorkflow),
		"ci.yml must define a container: job (2-space indent)",
	);
	assert.ok(
		ciWorkflow.includes("./make.sh image torus:ci"),
		"container job must build the image via ./make.sh image torus:ci",
	);
	assert.ok(
		ciWorkflow.includes("./make.sh image-test torus:ci"),
		"container job must run the container suite via ./make.sh image-test torus:ci",
	);
	assert.ok(
		ciWorkflow.includes("platforms: linux/amd64,linux/arm64"),
		"container job must publish linux/amd64,linux/arm64",
	);
	const pushLine = ciWorkflow.split("\n").find((line) => line.trim().startsWith("push: ${{"));
	assert.ok(pushLine, "container job must set a push: expression on build-push-action");
	assert.ok(pushLine.includes("refs/heads/main"), "push must be gated on refs/heads/main");
	assert.ok(pushLine.includes("refs/tags/v"), "push must be gated on refs/tags/v");
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
	// image default. A fresh container re-extracts the payload and npm-
	// bootstraps the engine on first run, so allow a generous timeout.
	// Keyless "No models available" on stdout is success (exit 0).
	const run = dockerRun(["run", "--rm", IMAGE, "--list-models"], 240_000);
	assert.equal(run.status, 0, `torus --list-models failed: ${describeResult(run)}`);
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
