import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-memory-improve-"));
process.env["TORUS_HOME"] = home;

const memory = await import("../extensions/memory/index.ts");

const entriesDir = path.join(home, "memory", "entries");

function toolText(result) {
	return result.content.map((part) => part.text).join("\n");
}

function writeRawEntry(name, frontmatter, body) {
	mkdirSync(entriesDir, { recursive: true });
	writeFileSync(path.join(entriesDir, name), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function entryFiles() {
	return readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
}

test("torus_remember blocks duplicates and force updates in place", async () => {
	const first = await memory.rememberTool.execute("t1", {
		topic: "Deploy rollback steps",
		content: "use git revert",
	});
	assert.match(toolText(first), /remembered/);
	const dup = await memory.rememberTool.execute("t2", {
		topic: "Deploy rollback steps",
		content: "updated body",
	});
	assert.match(toolText(dup), /already remembered as/);
	const mine = entryFiles().filter((f) => f.includes("deploy-rollback-steps"));
	assert.equal(mine.length, 1, "duplicate write must not create a second file");
	const forced = await memory.rememberTool.execute("t3", {
		topic: "Deploy rollback steps",
		content: "prefer revert over reset",
		force: true,
	});
	assert.match(toolText(forced), /updated/);
	assert.equal(
		entryFiles().filter((f) => f.includes("deploy-rollback-steps")).length,
		1,
		"force updates the existing file",
	);
	const raw = readFileSync(path.join(entriesDir, mine[0]), "utf8");
	assert.ok(raw.includes("prefer revert over reset"), "body replaced in place");
});

test("torus_remember sanitizes tags and caps content size", async () => {
	const res = await memory.rememberTool.execute("t", {
		topic: "Tag hygiene check",
		content: "body",
		tags: "react\nhooks: tips, closure",
	});
	assert.match(toolText(res), /remembered/);
	const file = entryFiles().find((f) => f.includes("tag-hygiene-check"));
	assert.ok(file, "entry written");
	const raw = readFileSync(path.join(entriesDir, file), "utf8");
	const fields = raw
		.split("---")[1]
		?.split("\n")
		.filter((line) => line.trim().length > 0);
	assert.equal(fields.length, 4, "frontmatter stays one field per line");
	assert.match(raw, /tags: react hooks tips, closure/);
	const big = await memory.rememberTool.execute("t", {
		topic: "Too large entry",
		content: "x".repeat(9000),
	});
	assert.match(toolText(big), /content too large/);
});

test("torus_forget deletes by exact filename and validates input", async () => {
	await memory.rememberTool.execute("t", { topic: "Forgettable lesson", content: "gone soon" });
	const file = entryFiles().find((f) => f.includes("forgettable-lesson"));
	assert.ok(file, "entry to forget exists");
	const gone = await memory.forgetTool.execute("t", { file });
	assert.match(toolText(gone), /forgot: Forgettable lesson/);
	assert.equal(existsSync(path.join(entriesDir, file)), false, "file removed");
	const bad = await memory.forgetTool.execute("t", { file: "not a valid name.md" });
	assert.match(toolText(bad), /invalid entry name/);
	const missing = await memory.forgetTool.execute("t", { file: "2099-01-01-nope-abc.md" });
	assert.match(toolText(missing), /no such entry/);
});

test("scoreEntries boosts tag matches and breaks ties newest-first", () => {
	const base = { tags: [], project: "global", pinned: false, created: "" };
	const taggedOld = {
		...base,
		file: "2024-01-01-tagged-old.md",
		topic: "Rollout runbook",
		tags: ["rollout"],
		body: "generic ops notes",
		created: "2024-01-01T00:00:00.000Z",
	};
	const untaggedNew = {
		...base,
		file: "2026-10-02-untagged-new.md",
		topic: "Random notes",
		body: "mentions rollout in passing",
		created: new Date().toISOString(),
	};
	const scored = memory.scoreEntries("rollout", [taggedOld, untaggedNew]);
	// taggedOld: word hit +1, tag-exact +2 = 3; untaggedNew: word +1, recency +1 = 2
	assert.equal(scored[0].entry.file, taggedOld.file, "tag match outranks recent word hit");
	const a = { ...base, file: "2024-01-01-a.md", topic: "Same thing", body: "x" };
	const b = { ...base, file: "2025-01-01-b.md", topic: "Same thing", body: "x" };
	const tie = memory.scoreEntries("same thing", [a, b]);
	assert.equal(tie[0].entry.file, b.file, "equal scores resolve newest-first");
	assert.deepEqual(memory.scoreEntries("   ", [a]), [], "blank query scores nothing");
});

test("memoryContextBlock orders pinned first, then relevance, then newest", () => {
	for (const f of entryFiles()) unlinkSync(path.join(entriesDir, f));
	writeRawEntry(
		"2024-01-01-pinned-keep.md",
		"topic: Pinned keystone\ntags: keep\nproject: global\ncreated: 2024-01-01T00:00:00.000Z\npinned: true",
		"always inject me",
	);
	writeRawEntry(
		"2024-02-02-alpha.md",
		"topic: Alpha old note\ntags: alpha\nproject: global\ncreated: 2024-02-02T00:00:00.000Z",
		"ancient history",
	);
	writeRawEntry(
		"2025-03-03-beta.md",
		"topic: Beta middle note\nproject: global\ncreated: 2025-03-03T00:00:00.000Z",
		"medium history",
	);
	writeRawEntry(
		"2026-09-30-gamma.md",
		"topic: Gamma fresh note\nproject: global\ncreated: 2026-09-30T00:00:00.000Z",
		"fresh history",
	);

	const block = memory.memoryContextBlock(process.cwd());
	assert.ok(block.includes("[pinned] Pinned keystone"), "pinned entry injected");
	const idx = (needle) => block.indexOf(needle);
	assert.ok(
		idx("Pinned keystone") < idx("Gamma fresh note"),
		"no query: newest first after pinned",
	);
	assert.ok(idx("Gamma fresh note") < idx("Beta middle note"));
	assert.ok(idx("Beta middle note") < idx("Alpha old note"));

	const relevant = memory.memoryContextBlock(process.cwd(), "alpha old note details please");
	assert.ok(
		idx("Pinned keystone") < relevant.indexOf("Alpha old note"),
		"pinned stays before relevant match",
	);
	assert.ok(
		relevant.indexOf("Alpha old note") < relevant.indexOf("Gamma fresh note"),
		"relevance beats recency",
	);
});

test("latestUserQuery takes the last real user message and skips torus blocks", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "assistant noise" }] },
		{ role: "user", content: [{ type: "text", text: "earlier user message" }] },
		{ role: "user", content: [{ type: "text", text: "[torus memory — informational notes]" }] },
		{
			role: "user",
			content: [
				{ type: "text", text: "fix the flaky deploy test" },
				{ type: "text", text: " in ci" },
			],
		},
	];
	assert.equal(memory.latestUserQuery(messages), "fix the flaky deploy test in ci");
	assert.equal(
		memory.latestUserQuery([
			{ role: "user", content: [{ type: "text", text: "[torus profile — informational]" }] },
		]),
		"",
	);
	assert.equal(memory.latestUserQuery([]), "");
});

test("dreamAppliedLine includes entry topics and deleted filenames", () => {
	const counts = {
		entries: 2,
		deletes: 1,
		profile: 1,
		entryTopics: ["Alpha lesson", "Beta lesson"],
		deletedFiles: ["2026-01-01-x-1.md"],
	};
	assert.equal(
		memory.dreamAppliedLine(counts, "dream"),
		"dream applied · +2 entries (Alpha lesson; Beta lesson) · −1 delete (2026-01-01-x-1.md) · profile +1",
	);
	assert.equal(
		memory.dreamAppliedLine(memory.emptyApplied(), "reflect"),
		"reflect complete · no changes",
	);
});

test("undreamedActivity ignores the dreamer's own delegation logs", () => {
	const logs = path.join(home, "logs");
	mkdirSync(logs, { recursive: true });
	writeFileSync(
		path.join(home, "memory", ".dream-state"),
		JSON.stringify({ lastDreamAt: Date.now() - 1000 }),
		"utf8",
	);
	writeFileSync(path.join(logs, "2026-10-02T00-00-00-000Z-dreamer.log"), "own output", "utf8");
	assert.equal(memory.undreamedActivity(), false, "a fresh dreamer log alone is not activity");
	writeFileSync(path.join(logs, "2026-10-02T00-00-01-000Z-builder.log"), "real work", "utf8");
	assert.equal(memory.undreamedActivity(), true, "a non-dreamer log newer than lastDreamAt counts");
});

test("entries can be session-stamped and restored first after compaction", () => {
	for (const f of entryFiles()) unlinkSync(path.join(entriesDir, f));
	writeRawEntry(
		"2024-01-01-own-session.md",
		"topic: Learned this session\ntags: x\nproject: global\ncreated: 2024-01-01T00:00:00.000Z\nsession: sess-42",
		"fresh session knowledge",
	);
	writeRawEntry(
		"2026-09-30-other.md",
		"topic: Other newer note\nproject: global\ncreated: 2026-09-30T00:00:00.000Z",
		"unrelated",
	);
	const restored = memory.memoryContextBlock(process.cwd(), "", "sess-42");
	assert.ok(restored.includes("[session] Learned this session"), "session entry marked");
	assert.ok(
		restored.indexOf("Learned this session") < restored.indexOf("Other newer note"),
		"session entry restored ahead of newer entries",
	);
	const plain = memory.memoryContextBlock(process.cwd());
	assert.ok(!plain.includes("[session]"), "no session marker without session context");
	assert.ok(plain.indexOf("Other newer note") < plain.indexOf("Learned this session"));
});

test("applyDreamProposal stamps the source session on new entries", () => {
	memory.applyDreamProposal(
		{
			entries: [{ topic: "Session stamped lesson", body: "b", tags: [], project: "global" }],
			deletes: [],
			profiles: [],
		},
		4,
		"sess-7",
	);
	const file = entryFiles().find((f) => f.includes("session-stamped-lesson"));
	assert.ok(file, "entry written");
	assert.match(readFileSync(path.join(entriesDir, file), "utf8"), /session: sess-7/);
});

test("torus_memories warns about unparseable entries", async () => {
	writeFileSync(
		path.join(entriesDir, "2020-01-01-corrupt-broken.md"),
		"not frontmatter at all\n",
		"utf8",
	);
	const res = await memory.listTool.execute("t", {});
	const text = toolText(res);
	assert.match(text, /unparseable entries \(invisible to recall\/injection\)/);
	assert.match(text, /2020-01-01-corrupt-broken\.md/);
});

test("cleanup", () => {
	rmSync(home, { recursive: true, force: true });
});
