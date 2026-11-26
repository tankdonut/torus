/**
 * torus — incognito extension.
 *
 * `torus --incognito` (or TORUS_INCOGNITO=1) runs a memoryless session:
 * memory's dreamer and reflection paths gate off inside the memory extension,
 * and the incognito sweep clears the project state dir's derived artifacts on
 * shutdown. A plain run (no flag) writes everything normally — the mode is
 * opt-in per session, never ambient. Inside the mode a warning `incognito`
 * statusline chip keeps the memoryless state visible for the whole session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childSessionPaths, incognitoActive, incognitoSweep } from "../incognito.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { setTorusChip } from "../ui/index.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

/** Statusline chip key; `torus:`-prefixed like the other extension-owned chips. */
export const INCOGNITO_STATUS_KEY = "torus:incognito";
const INCOGNITO_CHIP_TEXT = "incognito";

export default function incognitoExtension(pi: ExtensionAPI): void {
	if (!gateExtension("incognito", PLATFORM_SUPPORT)) return;
	if (!incognitoActive(process.argv.slice(2))) {
		pi.registerCommand("incognito", {
			description:
				"Restart incognito (only effective when the session was launched with --incognito)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"incognito: this session was not started with --incognito or TORUS_INCOGNITO=1; restart torus with the flag",
					"error",
				);
			},
		});
		return;
	}

	// Born dirty: a resumed session inherits artifacts from a prior (possibly
	// non-incognito) incarnation of the same session id, so the start sweep
	// runs before this session writes anything of its own.
	incognitoSweep();

	// Never cleared: the mode is fixed for the process lifetime, and the
	// session_start rewrite a rebind (/reload, /resume) triggers is a no-op on
	// the shared Symbol.for chip store.
	pi.on("session_start", (_event, ctx) => {
		setTorusChip(INCOGNITO_STATUS_KEY, ctx.ui.theme.fg("warning", INCOGNITO_CHIP_TEXT));
	});

	pi.on("session_shutdown", () => {
		incognitoSweep();
	});

	pi.registerCommand("incognito", {
		description: "Show what incognito mode removes on exit",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`incognito is ON: memory reflection and dreaming are disabled; on exit the project state dir loses its logs, monitors, bg, reflect-state, plans, work, goal, todo, and wake-spool dirs. ${childSessionPaths().length} child-session transcript(s) are kept (pi's /resume never lists them); each run's own transcript is pi's, not torus's, to delete.`,
				"info",
			);
		},
	});
}
