/**
 * torus — persona-themed input border.
 *
 * The editor's idle border color comes from the theme's
 * getThinkingBorderColor; the app accepts a replacement theme via
 * ui.setTheme ONLY for genuine `instanceof Theme` objects (the live theme is
 * a plain-object reconstruction whose proto-clones fail that check), so the
 * override is cloned from a REAL instance loaded by name — class methods
 * keep their constructor state and the border re-derives on every switch.
 *
 * Application is deferred to the next macrotask: the TUI's session-rebind
 * flow (/resume, /new, /fork, /reload) runs themeController.applyFromSettings()
 * AFTER session_start handlers return, so a synchronous ui.setTheme here is
 * immediately clobbered back to the settings theme (default purple border).
 * Timer FIFO keeps last-call-wins for rapid persona switches.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { PERSONA_COLORS, personaFg } from "./ui/index.js";

type AppTheme = ExtensionContext["ui"]["theme"];

interface ThemeUI {
	theme: AppTheme;
	getTheme?: (name: string) => unknown;
	setTheme(theme: string | AppTheme): { success: boolean; error?: string };
}

let baseTheme: AppTheme | null = null;

function currentThemeName(): string {
	try {
		const settings = JSON.parse(
			readFileSync(path.join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
		) as { theme?: string };
		if (typeof settings.theme === "string" && settings.theme.length > 0) return settings.theme;
	} catch {
		// unreadable settings — fall through to the system default
	}
	return "system";
}

function themedInstance(ui: ThemeUI): AppTheme | null {
	if (baseTheme instanceof Theme) return baseTheme;
	const byName = ui.getTheme?.(currentThemeName());
	return byName instanceof Theme ? (byName as AppTheme) : null;
}

export function applyPersonaTheme(ctx: ExtensionContext, persona: string | null): void {
	const ui = ctx.ui as ThemeUI;
	if (!baseTheme) baseTheme = ui.theme;
	const apply = (): void => {
		if (!persona || !PERSONA_COLORS[persona]) {
			const real = themedInstance(ui);
			if (real) ui.setTheme(real);
			return;
		}
		const source = themedInstance(ui);
		if (!source) return;
		const override = Object.create(source) as AppTheme & {
			getThinkingBorderColor: (level: string) => (text: string) => string;
		};
		override.getThinkingBorderColor = () => (text: string) => personaFg(persona, text);
		const result = ui.setTheme(override);
		if (process.env["TORUS_THEME_DEBUG"] === "1") {
			appendFileSync(
				"/tmp/opencode/theme-debug.log",
				`${new Date().toISOString()} persona=${persona} success=${String(result.success)} inst=${String(override instanceof Theme)}\n`,
			);
		}
	};
	setTimeout(apply, 0);
}
