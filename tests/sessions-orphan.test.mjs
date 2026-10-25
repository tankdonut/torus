import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const sessions = await import("../extensions/sessions/index.ts");

const SESSION_ID = "01234567-abcd-7def-8000-000000000000";

test("sessionFileExists: true when present, false when absent, null when root unreadable", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-sessions-orphan-"));
	try {
		const proj = path.join(root, "--some-project--");
		mkdirSync(proj);
		writeFileSync(path.join(proj, `2026-10-09T00-00-00-000Z_${SESSION_ID}.jsonl`), "{}", "utf8");

		assert.equal(sessions.sessionFileExists(SESSION_ID, root), true);
		assert.equal(sessions.sessionFileExists("00000000-0000-7000-8000-000000000000", root), false);
		assert.equal(sessions.sessionFileExists("anything", path.join(root, "no-such-root")), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sessionFileExists: session file directly under root also matches", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-sessions-flat-"));
	try {
		writeFileSync(path.join(root, `2026-10-09T00-00-00-000Z_${SESSION_ID}.jsonl`), "{}", "utf8");
		assert.equal(sessions.sessionFileExists(SESSION_ID, root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("searchSessions: oversized transcripts are skipped and counted, others still match", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-sessions-scan-"));
	try {
		const proj = path.join(root, "--scan-proj--");
		mkdirSync(proj);
		writeFileSync(
			path.join(proj, "2026-10-09T00-00-00-000Z_11111111-2222-7333-8444-555555555555.jsonl"),
			'{"text":"we fixed the mailbox cursors"}\n',
			"utf8",
		);
		// >8MB and containing the needle: skipped regardless, never a hit.
		const bigFile = path.join(
			proj,
			"2026-10-09T00-00-00-000Z_99999999-8888-7777-6666-555555555555.jsonl",
		);
		writeFileSync(
			bigFile,
			`${'"pad":"x"\n'.repeat(1_000_000)}{"text":"mailbox cursors in the big one"}\n`,
			"utf8",
		);
		writeFileSync(
			path.join(proj, "2026-10-09T00-00-00-000Z_aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl"),
			'{"text":"also mailbox cursors here"}\n',
			"utf8",
		);

		const stats = { skippedOversized: 0 };
		const hits = sessions.searchSessions("mailbox cursors", root, 10, stats);
		assert.equal(stats.skippedOversized, 1);
		assert.equal(hits.length, 2);
		assert.ok(
			hits.every((hit) => hit.file !== bigFile),
			"oversized transcript is never a hit",
		);
		assert.ok(hits.every((hit) => hit.snippet.includes("mailbox cursors")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("searchSessions: case-insensitive parity with the old toLowerCase scan", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-sessions-case-"));
	try {
		const proj = path.join(root, "--case-proj--");
		mkdirSync(proj);
		const line = "0123456789 we fixed the HeLLo cursors today";
		writeFileSync(
			path.join(proj, "2026-10-09T00-00-00-000Z_11111111-2222-7333-8444-555555555555.jsonl"),
			`{"a":1}\n${line}\n{"b":2}\n`,
			"utf8",
		);

		const hits = sessions.searchSessions("hello", root, 5);
		assert.equal(hits.length, 1);
		// Expected snippet computed exactly as the legacy toLowerCase path did.
		const lower = line.toLowerCase();
		const expected = line.slice(Math.max(0, lower.indexOf("hello") - 60), 220).replace(/\s+/g, " ");
		assert.equal(hits[0].snippet, expected);
		assert.match(hits[0].snippet, /HeLLo cursors/);

		assert.equal(sessions.searchSessions("HeLLo", root, 5).length, 1);
		assert.equal(sessions.searchSessions("HELLO CURSORS TODAY", root, 5).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sessionFileExists memo: unchanged root does zero additional directory listings", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-sessions-memo-"));
	try {
		const proj = path.join(root, "--memo-proj--");
		mkdirSync(proj);
		writeFileSync(path.join(proj, `2026-10-09T00-00-00-000Z_${SESSION_ID}.jsonl`), "{}", "utf8");

		assert.equal(sessions.sessionFileExists(SESSION_ID, root), true);
		const afterFirst = sessions._sessionsStats().dirListings;
		assert.ok(afterFirst > 0, "first lookup builds the index");

		assert.equal(sessions.sessionFileExists(SESSION_ID, root), true);
		assert.equal(sessions.sessionFileExists("00000000-0000-7000-8000-000000000000", root), false);
		assert.equal(sessions._sessionsStats().dirListings, afterFirst, "repeat lookups hit the memo");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
