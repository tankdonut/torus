import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Write-boundary redaction: every path into the git-backed store — the
// remember tool, the dream apply path, profile writes — masks well-known
// credential shapes before anything reaches disk or git history.
const home = mkdtempSync(path.join(tmpdir(), "torus-memory-redaction-"));
process.env["TORUS_HOME"] = home;

const memory = await import("../extensions/memory/index.ts");
const entriesDir = path.join(home, "memory", "entries");
const profileFile = path.join(home, "memory", "profile.md");

function toolText(result) {
	return result.content.map((part) => part.text).join("\n");
}

async function remember(topic, content, tags) {
	const result = await memory.rememberTool.execute("t", { topic, content, tags });
	const text = toolText(result);
	assert.match(text, /remembered/, "benign-shaped write must succeed");
	const name = /-> (\S+\.md)/.exec(text)?.[1];
	assert.ok(name, "tool result must name the entry file it wrote");
	return readFileSync(path.join(entriesDir, name), "utf8");
}

function storedEntryBySlug(slug) {
	const name = readdirSync(entriesDir).find((f) => f.endsWith(".md") && f.includes(slug));
	assert.ok(name, `entry file for slug ${slug} must exist`);
	return readFileSync(path.join(entriesDir, name), "utf8");
}

after(() => {
	rmSync(home, { recursive: true, force: true });
});

// every fake credential below is assembled at runtime from halves: no
// contiguous credential-shaped literal ships in source, where push-time
// secret scanners would flag the test fixture itself
const fake = (head, tail) => head + tail;

test("openai-style sk- tokens are masked in stored entries", async () => {
	const token = fake("sk-proj-9t4WqXb7", "Ld2RfH8mZc5Vn1YsK3jP6gQ0");
	const raw = await remember("Deploy key hygiene", `the CI env carried ${token} yesterday`);
	assert.ok(raw.includes("[REDACTED]"), "stored entry must carry the mask");
	assert.ok(!raw.includes(token), "the token itself must never reach disk");
});

test("github ghp_ tokens are masked in topic, echo, and stored entry", async () => {
	const token = fake("ghp_R8k2Lm5Qw9", "Zx4Vb7Nc1Jd6Fy3Gs0Ht8Ue5Pi2");
	const result = await memory.rememberTool.execute("t", {
		topic: `rotation ${token} broke ci`,
		content: "bot auth stopped working mid-deploy",
	});
	const text = toolText(result);
	assert.ok(!text.includes(token), "the tool echo must not repeat the token");
	const name = /-> (\S+\.md)/.exec(text)?.[1];
	assert.ok(name, "tool result must name the entry file it wrote");
	const raw = readFileSync(path.join(entriesDir, name), "utf8");
	assert.ok(raw.includes("rotation [REDACTED] broke ci"), "frontmatter topic must be masked");
	assert.ok(!raw.includes(token), "the token itself must never reach disk");
});

test("remaining vendor prefixes are each masked in stored entries", async () => {
	const tokens = [
		["github_pat_11ABCDE0123", "_abcdefghijklmnopqrstuvwxyz1234567890"],
		["gho_AbC123dEfGhIjKlMnOp", "QrStUvWxYz1234567890"],
		["ghs_AbC123dEfGhIjKlMnOp", "QrStUvWxYz1234567890"],
		["ghr_AbC123dEfGhIjKlMnOp", "QrStUvWxYz1234567890"],
		["hf_AbC123dEfGhIjKlMnOp", "QrStUvWxYz1234567"],
		["gsk_AbC123dEfGhIjKlMnOp", "QrStUvWxYz123456789012"],
		["rk_live_AbC123dEfGhIjKl", "MnOpQrStUvWxYz12"],
		["sk_live_AbC123dEfGhIjKlMn", "OpQrStUvWxYz123456"],
		["xoxb-123456789012-123456", "789012-AbCdEfGhIjKlMnOp"],
		["AIzaSyA-1234567890abcdef", "ghijklmnopqrstuv"],
	].map(([head, tail]) => head + tail);
	for (const [index, token] of tokens.entries()) {
		const raw = await remember(`Vendor shape ${index}`, `observed ${token} in logs`);
		assert.ok(!raw.includes(token), `${token.slice(0, 12)}… must be masked`);
		assert.ok(raw.includes("[REDACTED]"), "the mask must land instead");
	}
});

test("aws access-key ids are masked in stored entries", async () => {
	const token = fake("AKIAIOSFODNN7", "EXAMPLE");
	const raw = await remember("Upload credentials", `uploads use ${token} for signing`);
	assert.ok(raw.includes("[REDACTED]"), "the 20-char AWS shape must be masked");
	assert.ok(!raw.includes(token), "the access-key id must never reach disk");
});

test("jwts are masked in stored entries", async () => {
	const token = fake(
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOi",
		"IxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	);
	const raw = await remember("Session tokens", `auth header carried ${token} at 14:02`);
	assert.ok(raw.includes("[REDACTED]"), "the three-segment JWT must be masked");
	assert.ok(!raw.includes(token), "the JWT itself must never reach disk");
});

test("env assignments mask the value when NAME has a secret segment", async () => {
	const keyToken = fake("sk-proj-9t4WqXb7", "Ld2RfH8mZc5Vn1YsK3jP6gQ0");
	const opaque = "s3cr3tvalue99";
	const raw = await remember(
		"Shell rc findings",
		`export OPENAI_API_KEY=${keyToken}\nexport AUTH_TOKEN=${opaque}\nboth were live`,
	);
	assert.ok(
		raw.includes("OPENAI_API_KEY=[REDACTED]"),
		"secret-named NAME keeps its shape, value masked",
	);
	assert.ok(raw.includes("AUTH_TOKEN=[REDACTED]"), "opaque values behind secret names mask too");
	assert.ok(!raw.includes(keyToken) && !raw.includes(opaque), "neither value may reach disk");
});

test("tags are masked individually while benign tags survive", async () => {
	const token = fake("ghp_R8k2Lm5Qw9", "Zx4Vb7Nc1Jd6Fy3Gs0Ht8Ue5Pi2");
	const raw = await remember("Tag masking check", "body without shapes", `deploy, ${token}, ci`);
	assert.match(raw, /tags: deploy, \[REDACTED\], ci/);
	assert.ok(!raw.includes(token), "a token passed as a tag must never reach disk");
});

test("dream apply path masks tokens in the entries it writes", () => {
	const token = fake("ghp_R8k2Lm5Qw9", "Zx4Vb7Nc1Jd6Fy3Gs0Ht8Ue5Pi2");
	const counts = memory.applyDreamProposal({
		entries: [
			{
				topic: "Deploy key rotation lesson",
				body: `the bot token ${token} must rotate monthly`,
				tags: [],
				project: "global",
			},
		],
		deletes: [],
		profiles: [],
	});
	assert.equal(counts.entries, 1);
	const raw = storedEntryBySlug("deploy-key-rotation-lesson");
	assert.ok(raw.includes("[REDACTED]"), "dream-written entry must carry the mask");
	assert.ok(!raw.includes(token), "the dreamer's token must never reach disk");
});

test("profile facts mask tokens through the tool scope and the dream path", async () => {
	const opaque = "s3cr3tvalue99";
	const token = fake("ghp_R8k2Lm5Qw9", "Zx4Vb7Nc1Jd6Fy3Gs0Ht8Ue5Pi2");
	const toolResult = await memory.rememberTool.execute("t", {
		topic: "profile",
		content: `keeps AUTH_TOKEN=${opaque} in the shell rc`,
		scope: "profile",
	});
	assert.match(toolText(toolResult), /profile updated/);

	memory.applyDreamProposal({
		entries: [],
		deletes: [],
		profiles: [`rotates the deploy bot key ${token} monthly`],
	});

	const profile = readFileSync(profileFile, "utf8");
	assert.ok(
		profile.includes("AUTH_TOKEN=[REDACTED]"),
		"tool-written profile line must mask the value",
	);
	assert.ok(
		profile.includes("rotates the deploy bot key [REDACTED] monthly"),
		"dream profile line must mask the token",
	);
	assert.ok(
		!profile.includes(opaque) && !profile.includes(token),
		"no secret may reach profile.md",
	);
});

test("benign prose survives redaction untouched", async () => {
	const raw = await remember(
		"task-management checklist",
		[
			"prefers the sk-learn import style",
			"doc at https://maps.example.com/embed?center=AIzaSyA1 renders",
			"MONKEY=true stays legible",
			"velocity=distance over time, 2+2=4, x=y",
			"AKIAIOSFODNN7EXAMPLEx is 21 chars, not the exact 20-char shape",
			"the eyJtoo.short.x fragment is not a jwt",
		].join("\n"),
	);
	for (const line of [
		"task-management",
		"sk-learn",
		"AIzaSyA1",
		"MONKEY=true",
		"velocity=distance",
		"2+2=4",
		"AKIAIOSFODNN7EXAMPLEx",
		"eyJtoo.short.x",
	]) {
		assert.ok(raw.includes(line), `benign shape must pass through: ${line}`);
	}
	assert.ok(!raw.includes("[REDACTED]"), "a clean entry must carry no mask at all");
});

test("the duplicate guard scores masked text, so token-bearing topics still dedup", async () => {
	const token = fake("ghp_Q1w9Er8Ty6Ui3Op", "5As7Df9Gh1Jk3Lz5Xc7Vb1");
	const topic = `rotation ${token} incident`;
	const first = await memory.rememberTool.execute("t", { topic, content: "first write" });
	assert.match(toolText(first), /remembered/);
	const second = await memory.rememberTool.execute("t", { topic, content: "second write" });
	assert.match(
		toolText(second),
		/already remembered as/,
		"redacted topics must compare equal to the stored mask",
	);
	assert.ok(!toolText(second).includes(token), "the guard message must not echo the token");
});
