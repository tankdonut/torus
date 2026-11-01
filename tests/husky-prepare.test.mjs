import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "husky-prepare.mjs");

// The prepare script resolves node_modules relative to itself, so a fixture
// tree with just scripts/ (plus an optional husky bin) exercises it as-is.
function makeProject() {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-husky-"));
	mkdirSync(path.join(dir, "scripts"));
	copyFileSync(script, path.join(dir, "scripts", "husky-prepare.mjs"));
	return dir;
}

function installHuskyStub(dir, body) {
	const bin = path.join(dir, "node_modules", ".bin", "husky");
	mkdirSync(path.dirname(bin), { recursive: true });
	writeFileSync(bin, body);
	chmodSync(bin, 0o755);
	return bin;
}

function runPrepare(dir) {
	return spawnSync(process.execPath, ["scripts/husky-prepare.mjs"], {
		cwd: dir,
		encoding: "utf8",
	});
}

test("husky-prepare: exits 0 silently when husky is not installed", (t) => {
	const dir = makeProject();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const run = runPrepare(dir);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(run.stdout, "", "a skipped prepare must print nothing");
	assert.equal(run.stderr, "");
});

test("husky-prepare: invokes the installed husky binary with no arguments", (t) => {
	const dir = makeProject();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const record = path.join(dir, "husky-argv");
	installHuskyStub(dir, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`);

	const run = runPrepare(dir);
	assert.equal(run.status, 0, `stderr: ${run.stderr}`);
	assert.equal(
		readFileSync(record, "utf8").trim(),
		"",
		"husky must be invoked once with an empty argv",
	);
});

test("husky-prepare: propagates husky's exit code", (t) => {
	const dir = makeProject();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	installHuskyStub(dir, "#!/bin/sh\nexit 3\n");

	const run = runPrepare(dir);
	assert.equal(run.status, 3, "a failing husky must fail the install");
});
