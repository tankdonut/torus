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
