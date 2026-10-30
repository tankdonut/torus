import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Member mail: team_create gains the opt-in memberMail flag (objective
// sentence + spec persistence), and the member-facing CLI team-mail.mjs
// sends validated attributed mail. Fixtures go through the production
// team_create execute calls and a real CLI child; isolation mirrors
// tests/team-taskgraph.test.mjs.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-team-mail-test-"));
process.env.TORUS_HOME = HOME;
process.env.HOME = HOME;
process.env.TORUS_NOTIFY = "0";
process.env.TORUS_TMUX = "0";

const runtime = await import("../extensions/team-runtime.ts");
const registry = await import("../extensions/registry.ts");
const team = await import("../extensions/team/index.ts");

registry.setCustomSender(() => {});

// Fake member spawner — no engine child ever runs. Objectives are captured
// because the objective argument IS the member-visible protocol text.
const spawnedObjectives = [];
team.setMemberSpawnerForTesting((teamId, spec, objective, onState) => {
	spawnedObjectives.push({ teamId, name: spec.name, objective });
	return {
		stop: () => onState({ status: "stopped", sessionId: `sess-${spec.name}` }),
		forceKill: () => {},
		mailboxDir: path.join(HOME, "teams", teamId, "mailboxes", spec.name),
		exited: Promise.resolve(0),
	};
});

const TEAM_MAIL_CLI = fileURLToPath(new URL("../runtime/bin/team-mail.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Run the member CLI as a real child process — same env, so the child's
// team-runtime resolves teams under the same TORUS_HOME as the in-process one.
function teamMail(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [TEAM_MAIL_CLI, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function firstJsonLine(stdout) {
	return JSON.parse(stdout.trim().split("\n")[0]);
}

function tools() {
	const registered = [];
	team.registerTeam({ registerTool: (tool) => registered.push(tool) });
	return registered;
}

function tool(registered, name) {
	const found = registered.find((t) => t.name === name);
	assert.ok(found, `${name} tool must be registered`);
	return found;
}

async function newTeam(registered, slug, extra) {
	const created = await tool(registered, "team_create").execute(
		"call",
		{
			name: slug,
			objective: `${slug} objective`,
			members: [
				{ name: "alice", agent: "builder" },
				{ name: "bob", agent: "builder" },
			],
			...(extra ?? {}),
		},
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => `sess-${slug}` } },
	);
	assert.ok(created.details.teamId, "team_create must return a teamId");
	return created.details.teamId;
}

function inboxPath(teamId, member) {
	return path.join(runtime.teamDir(teamId), "mailboxes", member, "inbox.md");
}

function objectivesFor(teamId) {
	return spawnedObjectives.filter((o) => o.teamId === teamId).map((o) => o.objective);
}

after(() => {
	team.setMemberSpawnerForTesting(null);
	team.flushTeamWakesForTesting();
	registry.setCustomSender(() => {});
	registry.resetRegistryForTesting();
	rmSync(HOME, { recursive: true, force: true });
});

test("CLI send stamps the canonical FROM alice block in bob's inbox", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "mailok", { memberMail: true });
	const result = await teamMail(["send", teamId, "--as", "alice", "--to", "bob", "schema landed"]);
	assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.deepEqual(firstJsonLine(result.stdout), {
		ok: true,
		action: "send",
		from: "alice",
		to: "bob",
	});
	const inbox = readFileSync(inboxPath(teamId, "bob"), "utf8");
	assert.match(inbox, /\n\[[^\]]+\] FROM alice:\nschema landed\n$/);
});

test("unknown team, unknown sender, unknown recipient each refuse with exit 1", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "mailref");
	const unknownTeam = await teamMail([
		"send",
		"no-such-team-xyz",
		"--as",
		"alice",
		"--to",
		"bob",
		"hi",
	]);
	assert.equal(unknownTeam.code, 1);
	assert.ok(firstJsonLine(unknownTeam.stdout).error.includes("not found"));

	const unknownFrom = await teamMail(["send", teamId, "--as", "mallory", "--to", "bob", "hi"]);
	assert.equal(unknownFrom.code, 1);
	assert.match(firstJsonLine(unknownFrom.stdout).error, /mallory.*not a member/);

	const unknownTo = await teamMail(["send", teamId, "--as", "alice", "--to", "nobody", "hi"]);
	assert.equal(unknownTo.code, 1);
	assert.match(firstJsonLine(unknownTo.stdout).error, /nobody.*not a member/);
});

test("reserved senders lead and tasklist refuse", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "mailresv");
	for (const reserved of ["lead", "tasklist"]) {
		const result = await teamMail(["send", teamId, "--as", reserved, "--to", "bob", "hi"]);
		assert.equal(result.code, 1, `${reserved} must refuse`);
		assert.match(firstJsonLine(result.stdout).error, /reserved/);
	}
});

test("self-sends and empty text refuse, and a refusal leaves the inbox untouched", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "mailself");
	// The fake spawner never touches disk, so create bob's mailbox before pinning it.
	runtime.memberMailbox(teamId, "bob");
	const before = statSync(inboxPath(teamId, "bob"));

	const self = await teamMail(["send", teamId, "--as", "alice", "--to", "alice", "note to self"]);
	assert.equal(self.code, 1);
	assert.match(firstJsonLine(self.stdout).error, /yourself/);

	const empty = await teamMail(["send", teamId, "--as", "alice", "--to", "bob"]);
	assert.equal(empty.code, 1);
	assert.match(firstJsonLine(empty.stdout).error, /text/);

	const whitespace = runtime.deliverMemberMail(teamId, "alice", "bob", "   ");
	assert.equal(whitespace.ok, false, "blank text refuses at the validation layer too");

	const after = statSync(inboxPath(teamId, "bob"));
	assert.deepEqual(
		{ size: after.size, mtimeMs: after.mtimeMs },
		{ size: before.size, mtimeMs: before.mtimeMs },
		"a refused send writes nothing",
	);
});

test("default teams: no mail sentence and no memberMail key on the spec", async () => {
	const registered = tools();
	spawnedObjectives.length = 0;
	const teamId = await newTeam(registered, "maildef");
	const objectives = objectivesFor(teamId);
	assert.ok(objectives.length > 0, "the spawner must receive the member objective");
	for (const objective of objectives) {
		assert.equal(objective, "maildef objective", "objective unchanged, nothing appended");
		assert.ok(!objective.includes("team-mail.mjs"), "no mail sentence when memberMail is off");
	}
	const specText = readFileSync(path.join(runtime.teamDir(teamId), "team.json"), "utf8");
	assert.ok(!specText.includes("memberMail"), "spec JSON stays free of the memberMail key");
	assert.equal(runtime.readTeamSpec(teamId).memberMail, undefined, "spec round-trips absence");
});

test("opted-in teams: the objective ends with the exact mail sentence", async () => {
	const registered = tools();
	spawnedObjectives.length = 0;
	const teamId = await newTeam(registered, "mailon", { memberMail: true });
	const objectives = objectivesFor(teamId);
	assert.ok(objectives.length > 0);
	const sentence = `Send attributed teammate mail with \`node runtime/bin/team-mail.mjs send ${teamId} --as <your-name> --to <member> "<text>"\`; list members with the members subcommand.`;
	for (const objective of objectives) {
		assert.ok(objective.endsWith(sentence), "mail sentence is the last sentence");
		assert.equal(objective, `mailon objective ${sentence}`);
	}
	assert.equal(runtime.readTeamSpec(teamId).memberMail, true, "spec round-trips the flag");
});

test("both flags: self-claim sentence first, mail sentence second", async () => {
	const registered = tools();
	spawnedObjectives.length = 0;
	const teamId = await newTeam(registered, "mailboth", { selfClaim: true, memberMail: true });
	const objectives = objectivesFor(teamId);
	assert.ok(objectives.length > 0);
	const claim = `Claim work atomically with \`node runtime/bin/team-task.mjs claim ${teamId} --as <your-name>\`; only pending unassigned unblocked tasks are claimable; release with the release subcommand if you cannot finish.`;
	const mail = `Send attributed teammate mail with \`node runtime/bin/team-mail.mjs send ${teamId} --as <your-name> --to <member> "<text>"\`; list members with the members subcommand.`;
	for (const objective of objectives) {
		assert.equal(objective, `mailboth objective ${claim} ${mail}`);
	}
});

test("members lists name and agent lines; an unknown team refuses", async () => {
	const registered = tools();
	const teamId = await newTeam(registered, "maillist");
	const result = await teamMail(["members", teamId]);
	assert.equal(result.code, 0);
	const lines = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(lines, [
		{ name: "alice", agent: "builder" },
		{ name: "bob", agent: "builder" },
	]);

	const missing = await teamMail(["members", "no-such-team-xyz"]);
	assert.equal(missing.code, 1);
	assert.ok(firstJsonLine(missing.stdout).error.includes("not found"));
});
