import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-doctor-state-"));
process.env["TORUS_HOME"] = home;

const { stateLayoutCheck } = await import("../extensions/doctor/index.ts");

test("empty state root: state-layout is ok", () => {
	const root = path.join(home, "empty");
	mkdirSync(root, { recursive: true });
	const result = stateLayoutCheck(root);
	assert.equal(result.name, "state-layout");
	assert.equal(result.status, "ok");
});

test("legacy flat state: state-layout warns with per-store counts and deletes nothing", () => {
	const root = path.join(home, "legacy");
	mkdirSync(path.join(root, "plans"), { recursive: true });
	writeFileSync(path.join(root, "plans", "x.md"), "plan", "utf8");
	mkdirSync(path.join(root, "logs"), { recursive: true });
	writeFileSync(path.join(root, "logs", "y.log"), "log", "utf8");
	mkdirSync(path.join(root, "teams", "cursor-probe-123"), { recursive: true });
	writeFileSync(path.join(root, "teams", "cursor-probe-123", "team.json"), "{}", "utf8");
	mkdirSync(path.join(root, "teams", "regular-team"), { recursive: true });
	writeFileSync(path.join(root, "teams", "regular-team", "team.json"), "{}", "utf8");

	const result = stateLayoutCheck(root);

	assert.equal(result.status, "warn");
	assert.ok(result.detail.includes("plans/1"), `counts plans: ${result.detail}`);
	assert.ok(result.detail.includes("logs/1"), `counts logs: ${result.detail}`);
	assert.ok(result.detail.includes("teams residue/1"), `counts teams residue: ${result.detail}`);
	assert.ok(!result.detail.includes("work/"), `omits missing stores: ${result.detail}`);
	assert.ok(result.detail.includes("manual cleanup only"), `ends with hint: ${result.detail}`);

	assert.ok(existsSync(path.join(root, "plans", "x.md")), "check must not delete planted files");
	assert.ok(existsSync(path.join(root, "logs", "y.log")), "check must not delete planted files");
	assert.ok(
		existsSync(path.join(root, "teams", "cursor-probe-123", "team.json")),
		"check must not delete planted files",
	);
	assert.ok(
		existsSync(path.join(root, "teams", "regular-team", "team.json")),
		"check is read-only",
	);
});

test("namespaced state/ only: state-layout is ok", () => {
	const root = path.join(home, "namespaced");
	const stateDir = path.join(root, "state", "--tmp-somewhere--", "todo");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, "s1.json"), "{}", "utf8");

	const result = stateLayoutCheck(root);
	assert.equal(result.status, "ok");
});

test.after(() => {
	rmSync(home, { recursive: true, force: true });
});
