import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Team member model overrides: "primary"/"fast" shorthands are resolved to
// concrete chain heads before any record is written, so fleet rows, run
// beacons, and the delegation registry carry a real model id — the engine
// resolves shorthands itself, but torus's display surfaces do not. The
// spawner is faked so no engine runs.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-member-model-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";
delete process.env.TORUS_TEAM_NOTIFY;

// Built-in chain providers are credential-gated at resolution: dummy env
// values (presence only — nothing reads them) keep the shorthand resolution
// hermetic instead of depending on the machine's real agent dir.
const PREV_ZAI_KEY = process.env.ZAI_API_KEY;
const PREV_OPENCODE_KEY = process.env.OPENCODE_API_KEY;
process.env.ZAI_API_KEY = "torus-test-dummy";
process.env.OPENCODE_API_KEY = "torus-test-dummy";

const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");

registry.setCustomSender(() => {});

const spawned = [];
const spawn = (teamId, spec, _objective, onState) => {
	const mailboxDir = path.join(HOME, "teams", teamId, "mailboxes", spec.name);
	spawned.push({ teamId, spec, onState, mailboxDir });
	return {
		stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
		forceKill: () => {},
		mailboxDir,
		exited: Promise.resolve(0),
	};
};
team.setMemberSpawnerForTesting(spawn);

function createTool() {
	const tools = [];
	team.registerTeam({ registerTool: (tool) => tools.push(tool) });
	return tools.find((t) => t.name === "team_create");
}

after(() => {
	team.setMemberSpawnerForTesting(null);
	registry.setCustomSender(() => {});
	registry.resetRegistryForTesting();
	if (PREV_ZAI_KEY === undefined) delete process.env.ZAI_API_KEY;
	else process.env.ZAI_API_KEY = PREV_ZAI_KEY;
	if (PREV_OPENCODE_KEY === undefined) delete process.env.OPENCODE_API_KEY;
	else process.env.OPENCODE_API_KEY = PREV_OPENCODE_KEY;
	rmSync(HOME, { recursive: true, force: true });
});

test("member model shorthands resolve before records are written", async () => {
	registry.resetRegistryForTesting();
	spawned.length = 0;
	const result = await createTool().execute(
		"call",
		{
			name: "models",
			objective: "test objective",
			members: [
				{ name: "captain", agent: "reviewer", model: "primary" },
				{ name: "scout", agent: "explorer", model: "fast" },
				{ name: "pinned", agent: "builder", model: "zai/glm-5.3" },
			],
		},
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => "sess-models" } },
	);
	assert.ok(result.details.teamId, "team created");

	const delegationModels = Object.fromEntries(
		registry.listDelegations().map((r) => [r.handle, r.model]),
	);
	assert.equal(
		delegationModels.captain,
		"zai/glm-5.3",
		"'primary' resolves to the chain head in the delegation record",
	);
	assert.equal(
		delegationModels.scout,
		"zai/glm-5.3-flash",
		"'fast' resolves to the fast chain head",
	);
	assert.equal(delegationModels.pinned, "zai/glm-5.3", "exact ids pass through");

	const runModels = Object.fromEntries(registry.listExternalRuns().map((r) => [r.handle, r.model]));
	assert.equal(runModels.captain, "zai/glm-5.3", "fleet run row carries the resolved id");

	const spawnedModels = Object.fromEntries(spawned.map((s) => [s.spec.name, s.spec.model]));
	assert.equal(spawnedModels.captain, "zai/glm-5.3", "spawner receives the resolved model");
	assert.equal(spawnedModels.pinned, "zai/glm-5.3", "explicit ids reach the engine unchanged");
});
