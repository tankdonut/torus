import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The session-bus transport, against an in-process broker: one client plays
// the notification daemon (owns the well-known name, exports Notify, hands
// out fresh ids), the transport under test connects like the engine would.
const DIR = mkdtempSync(path.join(tmpdir(), "torus-osnotify-dbus-test-"));

const NOTIFY_DESCRIPTOR = {
	name: "org.freedesktop.Notifications",
	methods: {
		Notify: [
			"susssasa{sv}i",
			"u",
			["appName", "replacesId", "appIcon", "summary", "body", "actions", "hints", "expire"],
			["id"],
		],
	},
};

/** A listening broker plus its daemon client, handing ids from `firstId`. */
async function startDaemon({ firstId = 7, hangNotify = false, recordHints = false } = {}) {
	process.env.DBUS_SESSION_BUS_ADDRESS = "";
	const dbus = (await import("dbus-native")).default;
	const broker = dbus.createBroker();
	const address = await new Promise((resolve) =>
		broker.listen({ socket: path.join(DIR, `broker-${firstId}-${Date.now()}.sock`) }, (err, addr) =>
			resolve(addr),
		),
	);
	process.env.DBUS_SESSION_BUS_ADDRESS = address;
	const daemon = dbus.sessionBus();
	await daemon.requestName("org.freedesktop.Notifications", 0);
	const state = { ids: firstId, calls: 0, hints: null };
	daemon.exportInterface(
		{
			Notify: (...args) => {
				state.calls++;
				if (recordHints) state.hints = args[6];
				if (hangNotify) return new Promise(() => {});
				return state.ids++;
			},
		},
		"/org/freedesktop/Notifications",
		NOTIFY_DESCRIPTOR,
	);
	return {
		address,
		state,
		close: () => new Promise((resolve) => broker.close(resolve)),
	};
}

const dbus = await import("../extensions/osnotify-dbus.ts");

const TOAST = {
	summary: "torus ✓ done",
	body: "b",
	urgency: "low",
	expireMs: 6000,
	transient: true,
};

const daemons = [];

after(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close();
	rmSync(DIR, { recursive: true, force: true });
});

test("toasts ride the session bus and ids chain across calls", async () => {
	const daemon = await startDaemon({ recordHints: true });
	daemons.push(daemon);
	process.env.DBUS_SESSION_BUS_ADDRESS = daemon.address;
	dbus.resetTransportForTests();

	assert.equal(await dbus.dbusNotify(TOAST), 7);
	assert.equal(daemon.state.calls, 1);
	assert.equal(daemon.state.hints.urgency, 0);
	assert.equal(daemon.state.hints.transient, true);
	assert.equal(daemon.state.hints["desktop-entry"], "torus");
	assert.equal(await dbus.dbusNotify({ ...TOAST, replaceId: 7 }), 8);
});

test("an unreachable bus returns null without latching the transport", async () => {
	dbus.resetTransportForTests();
	process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/tmp/torus-test-absent-bus";
	assert.equal(await dbus.dbusNotify(TOAST), null);
	dbus.resetTransportForTests();
	const daemon = await startDaemon();
	daemons.push(daemon);
	process.env.DBUS_SESSION_BUS_ADDRESS = daemon.address;
	assert.equal(await dbus.dbusNotify(TOAST), 7);
});

test("a reply timeout latches the transport off for the process", async () => {
	const daemon = await startDaemon({ hangNotify: true });
	daemons.push(daemon);
	dbus.resetTransportForTests();
	process.env.DBUS_SESSION_BUS_ADDRESS = daemon.address;
	const started = Date.now();
	assert.equal(await dbus.dbusNotify(TOAST), null);
	assert.ok(Date.now() - started >= 2500, "the call should have waited for the timeout");
	assert.equal(await dbus.dbusNotify(TOAST), null);
	assert.ok(Date.now() - started < 5000, "the latched retry must not wait again");
	assert.equal(daemon.state.calls, 1, "the latched retry must not reach the daemon");
});
