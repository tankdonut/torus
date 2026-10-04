/**
 * torus — /exit.
 *
 * Alias for pi's built-in /quit: the TUI's /quit handler just calls its
 * internal shutdown, and the extension context exposes the same graceful
 * shutdown ("session_shutdown" events fire, extensions dispose, then the
 * process exits), so /exit is a faithful alias in every run mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Quit (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
