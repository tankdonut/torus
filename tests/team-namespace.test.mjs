import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Team state layout: teams live under the project-namespaced store
// (state/--<project>--/teams/<id>/) with a global id→project index
// (teams.json) so member children running from foreign cwds resolve them.
// TORUS_HOME lands in a sandbox before the runtime import.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-namespace-test-"));
process.env.TORUS_HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TEAM_NOTIFY = "0";

const runtime = await import("../extensions/team-runtime.ts");
const fsutil = await import("../extensions/fsutil.ts");

const KEY = fsutil.projectKey(process.cwd());

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("a new team lands in the project store and records its index entry", () => {
	runtime.writeTeamSpec("ns-new", {
		name: "ns-new",
		objective: "namespace fixture",
		members: [{ name: "solo", agent: "builder" }],
	});
	assert.equal(
		runtime.teamDir("ns-new"),
		path.join(HOME, "state", KEY, "teams", "ns-new"),
		"team dir resolves to the project-scoped store",
	);
	assert.ok(existsSync(path.join(HOME, "state", KEY, "teams", "ns-new", "team.json")));
	const index = JSON.parse(readFileSync(path.join(HOME, "teams.json"), "utf8"));
	assert.equal(index["ns-new"], KEY, "the index maps the team to its project key");
	assert.equal(
		existsSync(path.join(HOME, "teams", "ns-new")),
		false,
		"nothing lands in the flat store",
	);
});

test("teamDir resolves from a foreign cwd via the index", () => {
	const foreign = mkdtempSync(path.join(tmpdir(), "torus-foreign-cwd-"));
	const previous = process.cwd();
	try {
		process.chdir(foreign);
		assert.equal(
			runtime.teamDir("ns-new"),
			path.join(HOME, "state", KEY, "teams", "ns-new"),
			"resolution is cwd-independent once indexed",
		);
		assert.equal(runtime.readTeamSpec("ns-new")?.name, "ns-new");
	} finally {
		process.chdir(previous);
		rmSync(foreign, { recursive: true, force: true });
	}
});

test("a lost index entry self-heals from the state-store sweep", () => {
	rmSync(path.join(HOME, "teams.json"));
	const spec = runtime.readTeamSpec("ns-new");
	assert.equal(spec?.name, "ns-new", "the sweep finds the unindexed team");
	assert.equal(
		runtime.teamDir("ns-new"),
		path.join(HOME, "state", KEY, "teams", "ns-new"),
		"the healed index restores canonical resolution",
	);
	assert.ok(runtime.listTeamIds().includes("ns-new"));
});
