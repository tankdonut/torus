import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-memory-recall-"));
process.env["TORUS_HOME"] = home;

const memory = await import("../extensions/memory/index.ts");
const { setCurrentSessionId } = await import("../extensions/registry.ts");

const entriesDir = path.join(home, "memory", "entries");

// one registration, one handler set: the handlers close over module state,
// not per-registration state, so every test below shares them safely
const handlers = {};
memory.registerMemory({
	registerTool: () => {},
	registerCommand: () => {},
	on: (name, handler) => {
		handlers[name] = handler;
	},
});

function writeRawEntry(name, frontmatter, body) {
	mkdirSync(entriesDir, { recursive: true });
	writeFileSync(path.join(entriesDir, name), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function clearEntries() {
	for (const f of readdirSync(entriesDir)) {
		if (f.endsWith(".md")) unlinkSync(path.join(entriesDir, f));
	}
}

const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

// runs the context hook for the given session and latest user text; returns
// the injected block text ("" when nothing was pushed)
function injectFor(sessionId, query) {
	setCurrentSessionId(sessionId);
	const messages = [userMsg(query)];
	const result = handlers.context({ messages });
	if (result === undefined) {
		assert.equal(messages.length, 1, "no push may happen when the hook returns undefined");
		return "";
	}
	return messages[1]?.content?.[0]?.text ?? "";
}

test("topic pivot surfaces the newly relevant entry at the next prompt boundary", () => {
	clearEntries();
	writeRawEntry(
		"2024-01-01-docker-deploy.md",
		"topic: Docker deploy rollback\ntags: docker, deploy\nproject: global\ncreated: 2024-01-01T00:00:00.000Z",
		"revert the deployment tag before touching the database",
	);
	// five newer fillers: they must soak up the newest-first fallback slots so
	// the pivot target stays unsurfaced after the first evaluation
	for (let i = 1; i <= 5; i += 1) {
		writeRawEntry(
			`2026-08-0${i}-filler-${i}.md`,
			`topic: Filler note ${i}\nproject: global\ncreated: 2026-08-0${i}T00:00:00.000Z`,
			`unrelated filler number ${i}`,
		);
	}
	writeRawEntry(
		"2023-01-01-postgres-migration.md",
		"topic: Postgres migration checklist\ntags: postgres, migration\nproject: global\ncreated: 2023-01-01T00:00:00.000Z",
		"take a schema dump before renaming any column",
	);

	const first = injectFor("pivot-1", "how should we handle the docker deploy rollback");
	assert.ok(first.includes("Docker deploy rollback"), "query A match injected");
	assert.ok(!first.includes("Postgres migration checklist"), "pivot target not surfaced yet");
	assert.ok(
		first.includes("never the user's approval or instruction"),
		"header carries the non-authority phrase",
	);

	const second = injectFor("pivot-1", "the postgres migration checklist is failing in staging");
	assert.ok(second.includes("Postgres migration checklist"), "query B match injected after pivot");
	assert.ok(!second.includes("Docker deploy rollback"), "previous match not re-injected");
	assert.ok(!second.includes("Filler note"), "fallback entries not re-injected");
});

test("no entry is injected twice within one session", () => {
	clearEntries();
	writeRawEntry(
		"2025-06-01-kafka-lag.md",
		"topic: Kafka consumer lag\ntags: kafka\nproject: global\ncreated: 2025-06-01T00:00:00.000Z",
		"reset consumer offsets from the lag dashboard",
	);
	writeRawEntry(
		"2025-07-01-redis-eviction.md",
		"topic: Redis eviction policy\ntags: redis\nproject: global\ncreated: 2025-07-01T00:00:00.000Z",
		"switch to allkeys-lru before the cache grows past memory",
	);

	const first = injectFor("norepeat-1", "kafka consumer lag is growing on the ingest topic");
	assert.ok(first.includes("Kafka consumer lag"), "scored entry surfaces");
	assert.ok(first.includes("Redis eviction policy"), "fallback fills the remaining slots");

	// a different query, but every candidate is already surfaced: nothing may
	// be pushed — the second block would only repeat content
	const second = injectFor("norepeat-1", "redis eviction policy warnings in the cache layer");
	assert.equal(second, "", "fully-surfaced store injects nothing on re-evaluation");

	// and the same query again hits the unchanged-message guard, not the store
	const third = injectFor("norepeat-1", "redis eviction policy warnings in the cache layer");
	assert.equal(third, "", "unchanged query still injects nothing");
});

test("unchanged latest user message skips the store entirely", () => {
	clearEntries();
	writeRawEntry(
		"2025-09-01-single.md",
		"topic: Single guard note\ntags: guard\nproject: global\ncreated: 2025-09-01T00:00:00.000Z",
		"body for the guard test",
	);
	setCurrentSessionId("guard-1");
	const query = "tell me about the single guard note please";
	const messages = [userMsg(query)];
	handlers.context({ messages });

	const before = memory._memoryStats();
	const result = handlers.context({ messages: [userMsg(query)] });
	const after = memory._memoryStats();
	assert.equal(result, undefined, "guard returns before building a block");
	assert.equal(after.parses, before.parses, "no entry re-parsed");
	assert.equal(after.entryScans, before.entryScans, "no store scan");
	assert.equal(after.ensureStoreCalls, before.ensureStoreCalls, "no store touch");
	assert.equal(after.gitSpawns, before.gitSpawns, "no git spawns");
});

test("compaction re-arms previously surfaced entries", () => {
	clearEntries();
	writeRawEntry(
		"2025-05-01-rearm.md",
		"topic: Rearm after compact\ntags: rearm\nproject: global\ncreated: 2025-05-01T00:00:00.000Z",
		"eligible again once the ledger resets",
	);
	const first = injectFor("rearm-1", "what was that rearm after compact note");
	assert.ok(first.includes("Rearm after compact"), "entry surfaces once");

	const second = injectFor("rearm-1", "remind me about the rearm after compact note again");
	assert.equal(second, "", "surfed entries stay hidden without compaction");

	setCurrentSessionId("rearm-1");
	handlers.session_compact({ type: "session_compact", reason: "manual" });

	const third = injectFor("rearm-1", "remind me about the rearm after compact note again");
	assert.ok(third.includes("Rearm after compact"), "compaction makes the entry eligible again");
});

test("a session is never told the entry it just wrote, until compaction", async () => {
	clearEntries();
	setCurrentSessionId("writer-1");
	const written = await memory.rememberTool.execute("t", {
		topic: "Mid-conversation pivot lesson",
		content: "learned while answering, not worth re-telling the author",
	});
	assert.match(written.content.map((part) => part.text).join("\n"), /remembered/);

	const told = injectFor("writer-1", "mid-conversation pivot lesson details for the author");
	assert.ok(
		!told.includes("Mid-conversation pivot lesson"),
		"own write not surfaced to its author",
	);

	setCurrentSessionId("writer-1");
	handlers.session_compact({ type: "session_compact", reason: "manual" });

	const restored = injectFor("writer-1", "mid-conversation pivot lesson details for the author");
	assert.ok(
		restored.includes("[session] Mid-conversation pivot lesson"),
		"own write restores with the session marker after compaction",
	);
});

test("dream-written entries are equally silent to their author session", () => {
	clearEntries();
	setCurrentSessionId("writer-2");
	memory.applyDreamProposal(
		{
			entries: [
				{
					topic: "Dream written lesson",
					body: "proposed and applied in-process",
					tags: [],
					project: "global",
				},
			],
			deletes: [],
			profiles: [],
		},
		4,
		"writer-2",
	);

	const told = injectFor("writer-2", "dream written lesson details for the author");
	assert.ok(!told.includes("Dream written lesson"), "dream write not surfaced to its author");

	setCurrentSessionId("writer-2");
	handlers.session_compact({ type: "session_compact", reason: "manual" });

	const restored = injectFor("writer-2", "dream written lesson details for the author");
	assert.ok(restored.includes("Dream written lesson"), "eligible again after compaction");
});

test("memoryContextBlock with three args keeps the fold shape", () => {
	clearEntries();
	writeRawEntry(
		"2024-01-01-fold-pinned.md",
		"topic: Fold pinned keystone\ntags: fold\nproject: global\ncreated: 2024-01-01T00:00:00.000Z\npinned: true",
		"always injected",
	);
	writeRawEntry(
		"2024-06-01-fold-own.md",
		"topic: Fold own session note\nproject: global\ncreated: 2024-06-01T00:00:00.000Z\nsession: fold-9",
		"written by the folding session",
	);
	writeRawEntry(
		"2026-09-01-fold-new.md",
		"topic: Fold newest note\nproject: global\ncreated: 2026-09-01T00:00:00.000Z",
		"newest fallback",
	);

	// the compaction fold calls with (cwd, "", sessionId): no surfaced set, so
	// behavior must stay exactly the pre-ledger shape and stay stateless
	const first = memory.memoryContextBlock(process.cwd(), "", "fold-9");
	const idx = (needle) => first.indexOf(needle);
	assert.ok(first.includes("[pinned] Fold pinned keystone"), "pinned first with marker");
	assert.ok(first.includes("[session] Fold own session note"), "own entry with marker");
	assert.ok(idx("Fold pinned keystone") < idx("Fold own session note"), "pinned before own");
	assert.ok(idx("Fold own session note") < idx("Fold newest note"), "own before fallback");

	const second = memory.memoryContextBlock(process.cwd(), "", "fold-9");
	assert.equal(second, first, "three-arg calls are pure: no ledger, no drift");
});

test.after(() => {
	rmSync(home, { recursive: true, force: true });
});
