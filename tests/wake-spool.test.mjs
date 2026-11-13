import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// TORUS_HOME must land before the registry import — it derives the runs dir at
// module load. The spool lives under the project state dir, which rehashes
// from cwd on every call, so a sandboxed home keeps the real one untouched.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-wake-spool-test-"));
process.env.TORUS_HOME = HOME;
process.env.TORUS_NOTIFY = "0";
delete process.env.TORUS_WAKE;
// The queued-wake pins assume instant idle delivery; the debounce window is unit-tested in wake-gate.test.mjs.
process.env.TORUS_WAKE_COALESCE_MS = "0";

const gate = await import("../extensions/wake-gate.ts");
const registry = await import("../extensions/registry.ts");
const { projectStateDir } = await import("../extensions/fsutil.ts");

const spoolDir = () => path.join(projectStateDir(), "wake-spool");
const spoolFile = (sessionId) => path.join(spoolDir(), `${sessionId}.jsonl`);

function spoolLines(sessionId) {
	try {
		return readFileSync(spoolFile(sessionId), "utf8")
			.split("\n")
			.filter((line) => line !== "");
	} catch {
		return [];
	}
}

after(() => {
	registry.setCurrentSession(null);
	rmSync(HOME, { recursive: true, force: true });
});

test("queued wakes write-ahead to the session spool and clear on delivery", () => {
	gate._resetWakeGateForTesting();
	registry.setCurrentSession("spool-s1");

	// no sender registered: the flush cannot deliver, the entry must persist
	gate.queueWakeEntry({ customType: "torus.bg-exit", text: "bg build exited" });
	assert.equal(spoolLines("spool-s1").length, 1, "undelivered wake persists in the spool");

	// a registered sender drains it: delivered once, spool emptied
	const sent = [];
	registry.setCustomSender((message) => sent.push(message));
	gate.drainWakeSpool("spool-s1");
	assert.equal(spoolLines("spool-s1").length, 0, "delivered wake clears the spool");
	assert.equal(sent.length, 1, "drained marker is delivered exactly once");
	assert.equal(sent[0].customType, "torus.bg-exit", "drained marker keeps its customType");
	assert.equal(sent[0].content[0].text, "bg build exited");
	registry.setCustomSender(() => {});
	registry.setCurrentSession(null);
});

test("TORUS_WAKE=0 and engine children keep wakes in-process only", () => {
	gate._resetWakeGateForTesting();
	registry.setCurrentSession("spool-s2");
	process.env.TORUS_WAKE = "0";
	gate.queueWakeEntry({ customType: "torus.monitor-fired", text: "output changed" });
	assert.ok(!existsSync(spoolFile("spool-s2")), "disabled knob writes no spool");
	gate.drainWakeSpool("spool-s2");
	delete process.env.TORUS_WAKE;

	process.env.TORUS_ENGINE_CHILD = "1";
	gate.queueWakeEntry({ customType: "torus.monitor-fired", text: "child wake" });
	assert.ok(!existsSync(spoolFile("spool-s2")), "engine children grow no spool files");
	delete process.env.TORUS_ENGINE_CHILD;
	registry.setCurrentSession(null);
});

test("a pre-union spool record (prefixed customType, no severity/toast) still drains", () => {
	gate._resetWakeGateForTesting();
	registry.setCurrentSession("spool-old");
	mkdirSync(spoolDir(), { recursive: true });
	writeFileSync(
		spoolFile("spool-old"),
		`${JSON.stringify({
			id: "old-1",
			ts: new Date().toISOString(),
			entry: { customType: "torus.team-wake", text: "OLD-SPOOL-PAYLOAD: member idle" },
		})}\n`,
	);

	const sent = [];
	registry.setCustomSender((message) => sent.push(message));
	gate.drainWakeSpool("spool-old");
	assert.equal(sent.length, 1, "the old record drains");
	assert.equal(sent[0].customType, "torus.team-wake", "the marker type survives the round-trip");
	assert.equal(sent[0].content[0].text, "OLD-SPOOL-PAYLOAD: member idle");
	assert.equal(spoolLines("spool-old").length, 0, "delivered old record clears the spool");
	registry.setCustomSender(() => {});
	registry.setCurrentSession(null);
});

test("dropWakeEntries also removes the dropped entries from the spool", () => {
	gate._resetWakeGateForTesting();
	registry.setCurrentSession("spool-s3");
	gate._setWakeGateActiveForTesting(true); // hold entries mid-run

	gate.queueWakeEntry({ customType: "torus.team-wake", text: "member idle" });
	gate.queueWakeEntry({ customType: "torus.bg-exit", text: "bg build exited" });
	assert.equal(spoolLines("spool-s3").length, 2, "held entries are spooled");

	const dropped = gate.dropWakeEntries((entry) => entry.customType === "torus.team-wake");
	assert.equal(dropped, 1);
	assert.equal(spoolLines("spool-s3").length, 1, "dropped wake leaves the spool");
	assert.match(spoolLines("spool-s3")[0], /bg-exit/);

	gate._setWakeGateActiveForTesting(false);
	registry.setCurrentSession(null);
});

test("wakes queued without a session id are not spooled", () => {
	gate._resetWakeGateForTesting();
	registry.setCurrentSession(null);
	gate.queueWakeEntry({ customType: "torus.bg-exit", text: "nowhere to deliver" });
	assert.equal(spoolLines("null").length, 0);
});

test("drain collects spool files older than the retention window", () => {
	gate._resetWakeGateForTesting();
	registry.setCurrentSession("spool-gc");
	mkdirSync(spoolDir(), { recursive: true });
	const stale = path.join(spoolDir(), "stale-session.jsonl");
	writeFileSync(stale, "", "utf8");
	const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	utimesSync(stale, old, old);

	gate.drainWakeSpool("spool-gc");
	assert.ok(!existsSync(stale), "aged spool file is collected");
	registry.setCurrentSession(null);
});
