import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-reflect-state-"));
process.env["TORUS_HOME"] = home;

const rs = await import("../extensions/reflect-state.ts");

test("writeReflectState round-trips both fields; absent session reads zeros", () => {
	try {
		rs.writeReflectState("sess-rt", { lastReflectSettles: 7, lastReflectAt: 1234 });
		assert.deepEqual(rs.readReflectState("sess-rt"), {
			lastReflectSettles: 7,
			lastReflectAt: 1234,
		});
		assert.deepEqual(rs.readReflectState("never-written"), {
			lastReflectSettles: 0,
			lastReflectAt: 0,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("corrupt state file reads zeros", () => {
	try {
		rs.writeReflectState("sess-corrupt", { lastReflectSettles: 1, lastReflectAt: 1 });
		writeFileSync(rs.reflectStatePath("sess-corrupt"), "{ not json", "utf8");
		assert.deepEqual(rs.readReflectState("sess-corrupt"), {
			lastReflectSettles: 0,
			lastReflectAt: 0,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("gcReflectState removes only aged files; missing dir returns 0", () => {
	try {
		rs.writeReflectState("sess-fresh", { lastReflectSettles: 1, lastReflectAt: 1 });
		rs.writeReflectState("sess-old", { lastReflectSettles: 2, lastReflectAt: 2 });
		const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(rs.reflectStatePath("sess-old"), aged, aged);

		assert.equal(rs.gcReflectState(30 * 24 * 60 * 60 * 1000), 1);
		assert.equal(existsSync(rs.reflectStatePath("sess-old")), false);
		assert.equal(existsSync(rs.reflectStatePath("sess-fresh")), true);

		assert.equal(rs.gcReflectState(30 * 24 * 60 * 60 * 1000, Date.now()), 0, "fresh file kept");

		rmSync(rs.reflectStateDir(), { recursive: true, force: true });
		assert.equal(rs.gcReflectState(1000), 0, "missing dir returns 0");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unlinkLegacyReflectState removes the planted legacy file once", () => {
	try {
		const legacy = path.join(home, "memory", ".reflect-state");
		mkdirSync(path.join(home, "memory"), { recursive: true });
		writeFileSync(legacy, "{}", "utf8");

		assert.equal(rs.unlinkLegacyReflectState(), true);
		assert.equal(existsSync(legacy), false);
		assert.equal(rs.unlinkLegacyReflectState(), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("interleaved session writes stay independent", () => {
	try {
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
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
