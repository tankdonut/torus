import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-reflect-state-"));
process.env["TORUS_HOME"] = home;

const rs = await import("../extensions/reflect-state.ts");
const { sessionFileExists } = await import("../extensions/sessions/index.ts");

const DAY = 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * DAY;
const newDir = path.join(
	home,
	"state",
	`--${process.cwd().replace(/^\/+/, "").replaceAll("/", "-")}--`,
	"reflect-state",
);
const legacyPath = (id) => path.join(home, "reflect-state", `${id}.json`);

/** Drop state + legacy dirs so each test starts from a clean layout. */
function reset() {
	rmSync(path.join(home, "state"), { recursive: true, force: true });
	rmSync(path.join(home, "reflect-state"), { recursive: true, force: true });
}

function ageFile(file) {
	const when = new Date(Date.now() - 40 * DAY);
	utimesSync(file, when, when);
}

after(() => {
	rmSync(home, { recursive: true, force: true });
});

test("write lands under the per-project state dir and round-trips; absent session reads zeros", () => {
	reset();
	rs.writeReflectState("sess-rt", { lastReflectSettles: 7, lastReflectAt: 1234 });
	assert.equal(existsSync(path.join(newDir, "sess-rt.json")), true);
	assert.deepEqual(rs.readReflectState("sess-rt"), {
		lastReflectSettles: 7,
		lastReflectAt: 1234,
	});
	assert.deepEqual(rs.readReflectState("never-written"), {
		lastReflectSettles: 0,
		lastReflectAt: 0,
	});
});

test("corrupt state file reads zeros", () => {
	reset();
	rs.writeReflectState("sess-corrupt", { lastReflectSettles: 1, lastReflectAt: 1 });
	writeFileSync(rs.reflectStatePath("sess-corrupt"), "{ not json", "utf8");
	assert.deepEqual(rs.readReflectState("sess-corrupt"), {
		lastReflectSettles: 0,
		lastReflectAt: 0,
	});
});

test("legacy state still reads before any write", () => {
	reset();
	mkdirSync(path.dirname(legacyPath("sess-leg")), { recursive: true });
	writeFileSync(
		legacyPath("sess-leg"),
		JSON.stringify({ lastReflectSettles: 5, lastReflectAt: 99 }),
		"utf8",
	);
	assert.deepEqual(rs.readReflectState("sess-leg"), {
		lastReflectSettles: 5,
		lastReflectAt: 99,
	});
	assert.equal(existsSync(legacyPath("sess-leg")), true, "read must not move legacy state");
});

test("write migrates: new file written, legacy twin unlinked", () => {
	reset();
	mkdirSync(path.dirname(legacyPath("sess-mig")), { recursive: true });
	writeFileSync(
		legacyPath("sess-mig"),
		JSON.stringify({ lastReflectSettles: 1, lastReflectAt: 2 }),
		"utf8",
	);
	rs.writeReflectState("sess-mig", { lastReflectSettles: 8, lastReflectAt: 300 });
	assert.deepEqual(rs.readReflectState("sess-mig"), {
		lastReflectSettles: 8,
		lastReflectAt: 300,
	});
	assert.equal(existsSync(path.join(newDir, "sess-mig.json")), true);
	assert.equal(existsSync(legacyPath("sess-mig")), false);
});

test("a present new file wins over a valid legacy twin (no resurrection)", () => {
	reset();
	mkdirSync(newDir, { recursive: true });
	mkdirSync(path.dirname(legacyPath("sess-win")), { recursive: true });
	writeFileSync(
		legacyPath("sess-win"),
		JSON.stringify({ lastReflectSettles: 42, lastReflectAt: 42 }),
		"utf8",
	);
	writeFileSync(
		path.join(newDir, "sess-win.json"),
		JSON.stringify({ lastReflectSettles: 0, lastReflectAt: 0 }),
		"utf8",
	);
	assert.deepEqual(rs.readReflectState("sess-win"), {
		lastReflectSettles: 0,
		lastReflectAt: 0,
	});
});

test("gc: aged live session survives, aged orphan pruned, fresh kept, missing dir returns 0", () => {
	reset();
	rs.writeReflectState("sess-live", { lastReflectSettles: 1, lastReflectAt: 1 });
	rs.writeReflectState("sess-orphan", { lastReflectSettles: 2, lastReflectAt: 2 });
	rs.writeReflectState("sess-fresh", { lastReflectSettles: 3, lastReflectAt: 3 });
	ageFile(path.join(newDir, "sess-live.json"));
	ageFile(path.join(newDir, "sess-orphan.json"));

	const sessionsRoot = path.join(home, "pi-sessions");
	mkdirSync(sessionsRoot, { recursive: true });
	writeFileSync(path.join(sessionsRoot, "2026-01-01_sess-live.jsonl"), "{}", "utf8");
	const exists = (id) => sessionFileExists(id, sessionsRoot);

	assert.equal(exists("sess-live"), true);
	assert.equal(rs.gcReflectState(THIRTY_DAYS, Date.now(), exists), 1, "only the aged orphan goes");
	assert.equal(
		existsSync(path.join(newDir, "sess-live.json")),
		true,
		"aged state with a live session survives",
	);
	assert.equal(existsSync(path.join(newDir, "sess-orphan.json")), false, "aged orphan pruned");
	assert.equal(
		existsSync(path.join(newDir, "sess-fresh.json")),
		true,
		"fresh orphan kept by the age floor",
	);

	rmSync(path.join(home, "state"), { recursive: true, force: true });
	assert.equal(rs.gcReflectState(THIRTY_DAYS, Date.now(), exists), 0, "missing dir returns 0");
});

test("gc: unreadable sessions root keeps everything", () => {
	reset();
	rs.writeReflectState("sess-blind", { lastReflectSettles: 1, lastReflectAt: 1 });
	ageFile(path.join(newDir, "sess-blind.json"));
	const exists = (id) => sessionFileExists(id, path.join(home, "no-such-sessions-root"));
	assert.equal(exists("sess-blind"), null);
	assert.equal(rs.gcReflectState(THIRTY_DAYS, Date.now(), exists), 0);
	assert.equal(existsSync(path.join(newDir, "sess-blind.json")), true);
});

test("gc never deletes files under the legacy dir", () => {
	reset();
	mkdirSync(path.dirname(legacyPath("sess-legacy-orphan")), { recursive: true });
	writeFileSync(
		legacyPath("sess-legacy-orphan"),
		JSON.stringify({ lastReflectSettles: 1, lastReflectAt: 1 }),
		"utf8",
	);
	ageFile(legacyPath("sess-legacy-orphan"));
	rs.writeReflectState("sess-new-orphan", { lastReflectSettles: 2, lastReflectAt: 2 });
	ageFile(path.join(newDir, "sess-new-orphan.json"));
	assert.equal(
		rs.gcReflectState(THIRTY_DAYS, Date.now(), () => false),
		1,
		"only the new-dir orphan goes",
	);
	assert.equal(existsSync(legacyPath("sess-legacy-orphan")), true, "legacy dir is never pruned");
});

test("unlinkLegacyReflectState removes the planted legacy file once", () => {
	reset();
	const legacy = path.join(home, "memory", ".reflect-state");
	mkdirSync(path.join(home, "memory"), { recursive: true });
	writeFileSync(legacy, "{}", "utf8");

	assert.equal(rs.unlinkLegacyReflectState(), true);
	assert.equal(existsSync(legacy), false);
	assert.equal(rs.unlinkLegacyReflectState(), false);
});

test("interleaved session writes stay independent", () => {
	reset();
	rs.writeReflectState("sess-a", { lastReflectSettles: 3, lastReflectAt: 100 });
	rs.writeReflectState("sess-b", { lastReflectSettles: 9, lastReflectAt: 200 });
	assert.deepEqual(rs.readReflectState("sess-a"), {
		lastReflectSettles: 3,
		lastReflectAt: 100,
	});
	assert.deepEqual(rs.readReflectState("sess-b"), {
		lastReflectSettles: 9,
		lastReflectAt: 200,
	});
});
