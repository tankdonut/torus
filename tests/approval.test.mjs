import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const {
	registerApproval,
	decideTrust,
	parseCustomHost,
	projectSlug,
	readPersistedHosts,
	writePersistedHosts,
} = await import("../extensions/approval/index.ts");

const SLOT = Symbol.for("torus.approval.v1");

function handlerPi() {
	const handlers = {};
	return {
		handlers,
		on(event, handler) {
			handlers[event] = handler;
			return () => delete handlers[event];
		},
		registerTool() {},
	};
}

function fakeCtx({ selectScript, inputScript, hasUI = true, cwd } = {}) {
	const calls = { select: [], input: [] };
	return {
		calls,
		hasUI,
		cwd,
		ui: {
			async select(title, labels, opts) {
				calls.select.push({ title, labels, opts });
				const answer = selectScript?.[calls.select.length - 1];
				return answer === undefined ? undefined : answer;
			},
			async input(title) {
				calls.input.push({ title });
				const answer = inputScript?.[calls.input.length - 1];
				return answer === undefined ? undefined : answer;
			},
		},
	};
}

test("projectSlug: sanitizes cwd like registry precedent, falls back to default", () => {
	assert.equal(projectSlug("/var/home/u/Dev/torus"), "varhomeudevtorus");
	assert.equal(projectSlug("///"), "default");
});

test("parseCustomHost: exact hosts and *.domain pass; anything else null", () => {
	assert.equal(parseCustomHost(" Internal.Corp "), "internal.corp");
	assert.equal(parseCustomHost("*.golang.org"), "*.golang.org");
	assert.equal(parseCustomHost("delete everything"), null);
	assert.equal(parseCustomHost("*"), null);
	assert.equal(parseCustomHost("run the tests first"), null);
});

test("persisted hosts: round-trip in an isolated root, corrupt file reads empty", () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-appr-"));
	writePersistedHosts("/proj/a", ["a.dev", "a.dev", "b.dev"], root);
	assert.deepEqual(readPersistedHosts("/proj/a", root), ["a.dev", "b.dev"]);
	const file = path.join(root, `${projectSlug("/proj/a")}-hosts.json`);
	assert.ok(existsSync(file));
	writeFileSync(file, "{not json");
	assert.deepEqual(readPersistedHosts("/proj/a", root), []);
});

test("decideTrust: persisted host allows silently without a dialog", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-appr-"));
	writePersistedHosts("/proj/a", ["known.dev"], root);
	const ctx = fakeCtx({ selectScript: [undefined], cwd: "/proj/a" });
	const decision = await decideTrust(ctx, "known.dev", 443, {
		hostsRoot: root,
		persist: () => assert.fail("must not persist"),
	});
	assert.deepEqual(decision, { kind: "allow" });
	assert.equal(ctx.calls.select.length, 0);
});

test("decideTrust: always persists; custom host is parsed; garbage custom denies", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "torus-appr-"));
	const persisted = [];
	const persist = (hosts) => persisted.push(hosts);
	const always = await decideTrust(
		fakeCtx({ selectScript: ["Always allow (this project)"] }),
		"new.dev",
		443,
		{
			hostsRoot: root,
			persist,
		},
	);
	assert.deepEqual(always, { kind: "always" });
	assert.deepEqual(persisted.at(-1), ["new.dev"]);

	const custom = await decideTrust(
		fakeCtx({ selectScript: ["Custom…"], inputScript: ["*.internal.corp"] }),
		"x.dev",
		443,
		{ hostsRoot: root, persist },
	);
	assert.deepEqual(custom, { kind: "custom", text: "*.internal.corp", host: "*.internal.corp" });

	const garbage = await decideTrust(
		fakeCtx({ selectScript: ["Custom…"], inputScript: ["just let me out"] }),
		"x.dev",
		443,
		{ hostsRoot: root, persist },
	);
	assert.deepEqual(garbage, { kind: "custom", text: "just let me out", host: null });
});

test("decideTrust: deny on dismiss/timeout, deny on headless, custom cancel denies", async () => {
	const dismissed = await decideTrust(fakeCtx({ selectScript: [undefined] }), "a.dev", 443, {});
	assert.deepEqual(dismissed, { kind: "deny" });
	const headless = await decideTrust(fakeCtx({ hasUI: false }), "a.dev", 443, {});
	assert.deepEqual(headless, { kind: "deny" });
	assert.equal(headless.calls?.select?.length ?? 0, 0);
	const cancelled = await decideTrust(
		fakeCtx({ selectScript: ["Custom…"], inputScript: [undefined] }),
		"a.dev",
		443,
		{},
	);
	assert.deepEqual(cancelled, { kind: "deny" });
});

test("registerApproval: installs the slot, captures ctx, session-caches and dedups", async () => {
	const previous = process.env.TORUS_APPROVAL;
	delete process.env.TORUS_APPROVAL;
	const existing = globalThis[SLOT];
	try {
		const pi = handlerPi();
		registerApproval(pi);
		const slot = globalThis[SLOT];
		assert.ok(slot, "slot installed");
		const ctx = fakeCtx({ selectScript: ["Allow once"], cwd: "/proj/a" });
		await pi.handlers.session_start({ type: "session_start" }, ctx);
		const first = await slot.askNetworkTrust("fresh.dev", 443);
		assert.deepEqual(first, { kind: "allow" });
		const second = await slot.askNetworkTrust("fresh.dev", 443);
		assert.deepEqual(second, { kind: "allow" });
		assert.equal(ctx.calls.select.length, 1, "session cache suppresses repeat prompts");
		const denied = await slot.askNetworkTrust("other.dev", 443);
		assert.equal(denied.kind, "deny");
		assert.deepEqual(await slot.askNetworkTrust("other.dev", 443), { kind: "deny" });
		assert.equal(ctx.calls.select.length, 2, "deny also sticky");
	} finally {
		if (existing === undefined) delete globalThis[SLOT];
		else globalThis[SLOT] = existing;
		if (previous === undefined) delete process.env.TORUS_APPROVAL;
		else process.env.TORUS_APPROVAL = previous;
	}
});

test("registerApproval: TORUS_APPROVAL=0 leaves no slot", () => {
	const previous = process.env.TORUS_APPROVAL;
	const existing = globalThis[SLOT];
	delete globalThis[SLOT];
	try {
		process.env.TORUS_APPROVAL = "0";
		registerApproval(handlerPi());
		assert.equal(globalThis[SLOT], undefined);
	} finally {
		if (existing !== undefined) globalThis[SLOT] = existing;
		if (previous === undefined) delete process.env.TORUS_APPROVAL;
		else process.env.TORUS_APPROVAL = previous;
	}
});
