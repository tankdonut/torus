/**
 * torus — session-bus notification transport.
 *
 * Sends org.freedesktop.Notifications.Notify calls over one persistent
 * connection per engine process. The long-lived sender is what makes GNOME's
 * notification daemon group toasts under the torus desktop entry and keep
 * resident toasts in the tray while the engine runs: with a per-toast sender
 * (notify-send), GNOME resolves the app and then destroys the whole
 * notification source the moment the sender's connection vanishes — grouped
 * toasts would never outlive the banner.
 *
 * Fails closed: an unreachable bus yields null and the caller falls back to
 * notify-send (osnotify.ts). A connect failure is retried on the next toast;
 * a reply timeout latches the transport off for the process lifetime so later
 * toasts cannot pay a 3s stall each.
 */
import type { Socket } from "node:net";
// dbus-native loads on the first toast (see openSession below): a static
// import would put its module tree into every spawned engine's cold start
import type { MessageBus } from "dbus-native";

type Native = typeof import("dbus-native");

const REPLY_TIMEOUT_MS = 3000;

/** urgency byte of the freedesktop notification spec. */
const URGENCY = { low: 0, normal: 1, critical: 2 } as const;

export interface DbusNotifyMessage {
	summary: string;
	body: string;
	urgency: "low" | "normal" | "critical";
	/** 0 asks the server to keep the toast until dismissed. */
	expireMs: number;
	/** Transient toasts banner without persisting in the message tray. */
	transient: boolean;
	/** Server id to replace in place (a run's running-late ping). */
	replaceId?: number;
}

let dbus: Native | null = null;
let bus: MessageBus | null = null;
let timedOut = false;

/** Fresh transport state (for tests; the real process keeps one lifetime). */
export function resetTransportForTests(): void {
	dbus = null;
	bus = null;
	timedOut = false;
}

/** Open the session bus; null while unavailable (retry the next toast). */
function openSession(native: Native): MessageBus | null {
	if (bus) return bus;
	try {
		const opened = native.sessionBus();
		// the connection forwards stream errors; the bus intentionally does not
		// listen for them (an unhandled one crashes the process), so this side
		// must — the failing call still observes its own rejection
		opened.connection.on("error", () => {});
		(opened.connection.stream as Socket).unref();
		bus = opened;
	} catch {
		// no session bus address — retry the next toast, nothing latched
	}
	return bus;
}

/**
 * The D-Bus equivalent of the notify-send path: same summary/body pair,
 * urgency/transient/desktop-entry hints, expire timeout, and replace-id
 * chaining. Resolves to the server notification id for later in-place
 * replacement, or null when the bus is unavailable or the send failed.
 */
export async function dbusNotify(message: DbusNotifyMessage): Promise<number | null> {
	if (timedOut) return null;
	let native: Native;
	try {
		native = dbus ??= await import("dbus-native");
	} catch {
		return null;
	}
	const sender_ = openSession(native);
	if (!sender_) return null;
	try {
		const reply = await sender_.invoke(
			{
				destination: "org.freedesktop.Notifications",
				path: "/org/freedesktop/Notifications",
				interface: "org.freedesktop.Notifications",
				member: "Notify",
				signature: "susssasa{sv}i",
				body: [
					"torus",
					message.replaceId ?? 0,
					"",
					message.summary,
					message.body,
					[],
					{
						urgency: new dbus.Variant("y", URGENCY[message.urgency]),
						transient: new dbus.Variant("b", message.transient),
						"desktop-entry": new dbus.Variant("s", "torus"),
					},
					message.expireMs,
				],
			},
			{ timeout: REPLY_TIMEOUT_MS },
		);
		const id = typeof reply === "number" ? reply : Number.parseInt(String(reply), 10);
		return Number.isInteger(id) && id > 0 ? id : null;
	} catch (error) {
		if (error instanceof native.TimeoutError) timedOut = true;
		// reconnect on the next toast; only a reply timeout latches the transport off
		bus = null;
		return null;
	}
}
