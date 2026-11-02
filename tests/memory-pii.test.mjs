import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Profile-line PII screen at the write boundary: the person-model surface is
// injected into every future session in every project, so personal-life
// specifics are refused on both admission paths — the remember tool's profile
// scope and dreamer proposals. Entries stay unscreened by design.
const home = mkdtempSync(path.join(tmpdir(), "torus-memory-pii-"));
process.env["TORUS_HOME"] = home;

const memory = await import("../extensions/memory/index.ts");
const profileFile = path.join(home, "memory", "profile.md");

function toolText(result) {
	return result.content.map((part) => part.text).join("\n");
}

function storedProfile() {
	return existsSync(profileFile) ? readFileSync(profileFile, "utf8") : "";
}

async function rememberProfile(content) {
	return memory.rememberTool.execute("t", { topic: "profile", content, scope: "profile" });
}

after(() => {
	rmSync(home, { recursive: true, force: true });
});

test("profile scope rejects residence-location lines", async () => {
	const result = await rememberProfile(
		"Commissioned a home-solar study for his own Missouri/Illinois residence",
	);
	assert.ok(result.isError, "the write must be refused");
	assert.match(toolText(result), /personal life/);
	assert.match(toolText(result), /residence/);
	assert.ok(!storedProfile().includes("Missouri"), "nothing may land in the profile");
});

test("each PII signal family rejects a matching profile line", async () => {
	const lines = [
		"Lives in the St Louis metro area and works from his house there",
		"His wife reviews pull requests before merge on family projects",
		"Was diagnosed with carpal tunnel and prefers voice dictation",
		"Negotiates salary benchmarks annually against market data",
		"Home address stays off GitHub profile pages for privacy",
	];
	for (const line of lines) {
		const result = await rememberProfile(line);
		assert.ok(result.isError, `line must be rejected: ${line}`);
		assert.ok(!storedProfile().includes(line.slice(0, 20)), `nothing may land: ${line}`);
	}
});

test("working-behavior profile lines still land", async () => {
	const line = "Directs plan arcs with one-word imperatives, each landing as full authorization";
	const result = await rememberProfile(line);
	assert.ok(!result.isError, `behavioral line must pass: ${toolText(result)}`);
	assert.ok(storedProfile().includes("one-word imperatives"), "the line must be stored");
});

test("dream proposals drop PII profile lines, keeping clean ones", () => {
	const before = storedProfile();
	const counts = memory.applyDreamProposal({
		entries: [],
		deletes: [],
		profiles: [
			"Commissioned a total-coverage home-solar build study for his own Missouri/Illinois residence",
			"Files UI polish nits as rapid one-line follow-ups mid-task",
		],
	});
	assert.equal(counts.profile, 1, "only the clean line counts as applied");
	const after = storedProfile();
	assert.ok(after.includes("one-line follow-ups"), "clean line lands");
	assert.ok(!after.includes("Missouri"), "PII line never lands");
	assert.ok(after.length >= before.length, "existing lines survive");
});

test("entries stay unscreened: personal-life wording still writes", async () => {
	const result = await memory.rememberTool.execute("t", {
		topic: "Entry boundary choice",
		content:
			"Entries carry the no-PII policy at the prompt layer only; a body mentioning a residence writes today, screening is profile-scope",
	});
	assert.ok(!result.isError, `entry write must succeed: ${toolText(result)}`);
});
