/**
 * Regenerates the real TUI captures rendered on the landing page.
 *
 * Boots the actual torus TUI inside a fixed-geometry tmux session, delegates a
 * small task to an explorer agent, and snapshots the panes (with SGR colors)
 * as the run progresses. The .ans files plus captures.json are committed, so
 * this only needs a re-run when a surface changes:
 *
 *     npm run -w site capture
 *
 * Costs a few cents: the explorer dispatch runs on a flash-tier model and the
 * lead session takes no model turns (slash dispatches are direct tool calls).
 * TORUS_DREAMING=0 keeps the idle dreamer from spawning mid-capture.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(siteRoot, "..");
const outDir = resolve(siteRoot, "src", "tui");

const SESSION = "torus-site-capture";
const WIDTH = 140;
const HEIGHT = 32;
const DISPATCH =
	"list every exported symbol in extensions/fsutil.ts with a one-line summary of each";

const tmux = (args, opts = {}) =>
	spawnSync("tmux", args, { encoding: "utf8", timeout: 15_000, ...opts });
const run = (command, env = {}) =>
	spawnSync(command, {
		shell: true,
		encoding: "utf8",
		cwd: repoRoot,
		env: { ...process.env, ...env },
	});

const paneText = (pane) => tmux(["capture-pane", "-p", "-t", pane]).stdout ?? "";

// Captures must not leak the operator's directory layout: rewrite the repo
// path (absolute and ~-abbreviated) and any other home path to a generic one
// before the artifact is written.
const home = process.env["HOME"] ?? "";
const tildeRepo = home !== "" && repoRoot.startsWith(home) ? `~${repoRoot.slice(home.length)}` : "";
const REDACTIONS = [
	[repoRoot, "/home/user/torus"],
	[tildeRepo, "~/torus"],
	[home, "/home/user"],
].filter(([from]) => from !== "");

const redact = (text) => {
	let out = text;
	for (const [from, to] of REDACTIONS) out = out.replaceAll(from, to);
	return out;
};
const capture = (pane, name) => {
	const colored = tmux(["capture-pane", "-e", "-p", "-t", pane]);
	if (colored.status !== 0) throw new Error(`capture failed for ${name}`);
	writeFileSync(resolve(outDir, `${name}.ans`), redact(colored.stdout));
	console.log(`site: captured ${name}`);
};

function waitFor(pane, pattern, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	const test =
		pattern instanceof RegExp ? (text) => pattern.test(text) : (text) => text.includes(pattern);
	while (Date.now() < deadline) {
		if (test(paneText(pane))) return;
		sleep(500);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Pane id of the live delegation side pane, or null once it closed. */
function delegationPane() {
	const list = tmux(["list-panes", "-t", SESSION, "-F", "#{pane_id} #{pane_title}"]);
	if (list.status !== 0) return null;
	const row = (list.stdout ?? "").split("\n").find((line) => / torus: /.test(line));
	return row ? row.split(" ")[0] : null;
}

function teardown(stateDir, success) {
	tmux(["send-keys", "-t", `${SESSION}.0`, "/exit", "Enter"]);
	sleep(1500);
	tmux(["kill-session", "-t", SESSION]);
	rmSync(stateDir, { recursive: true, force: true });
	if (!success) {
		console.error("site: capture run FAILED; artifacts above (if any) are partial");
		process.exitCode = 1;
	}
}

mkdirSync(outDir, { recursive: true });
tmux(["kill-session", "-t", SESSION]);

if (run("test -d node_modules/@earendil-works/pi-coding-agent").status !== 0) {
	console.error("site: engine missing; run npm install at the repo root first");
	process.exit(1);
}

const stateDir = mkdtempSync(resolve(tmpdir(), "torus-site-capture-"));
tmux([
	"new-session",
	"-d",
	"-s",
	SESSION,
	"-x",
	String(WIDTH),
	"-y",
	String(HEIGHT),
	"-c",
	repoRoot,
	`env TORUS_STATE_DIR=${stateDir} TORUS_DREAMING=0 ./runtime/bin/torus.mjs`,
]);

let ok = false;
try {
	waitFor(`${SESSION}.0`, "torus · leader", 60_000, "TUI boot (statusline)");

	// The roster scene is stateless; capture it before any dispatch or fleet
	// overlay exists, while the editor is guaranteed empty and focused. 91
	// columns is the width the main pane will have once the delegation split
	// opens, so every scene renders at the same width.
	tmux(["resize-window", "-t", SESSION, "-x", "91"]);
	sleep(1500);
	tmux(["send-keys", "-t", `${SESSION}.0`, "/roster", "Enter"]);
	waitFor(`${SESSION}.0`, "concurrency caps", 20_000, "roster output");
	sleep(1000);
	capture(`${SESSION}.0`, "roster");
	tmux(["resize-window", "-t", SESSION, "-x", String(WIDTH)]);
	sleep(1500);

	tmux(["send-keys", "-t", `${SESSION}.0`, `/explorer ${DISPATCH}`, "Enter"]);
	waitFor(`${SESSION}.0`, "torus fleet", 30_000, "fleet strip after dispatch");
	sleep(2000);
	capture(`${SESSION}.0`, "statusline-fleet");

	const sidePane = delegationPane();
	if (sidePane) {
		sleep(8000);
		// Capture the side pane at the main pane's width so every scene renders
		// at one width: tmux reflows the tailed log onto the wider grid, and the
		// split is restored before the main-pane scenes run.
		const paneWidth = (pane) =>
			(tmux(["display-message", "-p", "-t", pane, "#{pane_width}"]).stdout ?? "").trim();
		const mainWidth = paneWidth(`${SESSION}.0`);
		const sideWidth = paneWidth(sidePane);
		if (mainWidth !== "" && sideWidth !== "") {
			tmux(["resize-pane", "-t", sidePane, "-x", mainWidth]);
			sleep(2500);
			capture(sidePane, "delegation-pane");
			tmux(["resize-pane", "-t", sidePane, "-x", sideWidth]);
			sleep(1000);
		} else {
			capture(sidePane, "delegation-pane");
		}
	} else {
		console.warn("site: delegation pane already closed; skipping delegation-pane");
	}

	tmux(["send-keys", "-t", `${SESSION}.0`, "Escape"]);
	sleep(600);
	// tmux key names use the M- prefix for Alt; "Alt+t" would be typed literally
	// into the chat editor. The overlay list renders a ❯ pointer on the
	// selected row; the always-on strip never does.
	tmux(["send-keys", "-t", `${SESSION}.0`, "M-t"]);
	waitFor(`${SESSION}.0`, "❯", 10_000, "fleet browser list");
	sleep(1500);
	capture(`${SESSION}.0`, "fleet-list");

	// M-1 is the strip slot shortcut: it opens the first running agent's
	// detail directly. Detail mode drops the row list (no ❯) and the strip.
	tmux(["send-keys", "-t", `${SESSION}.0`, "Escape"]);
	sleep(600);
	tmux(["send-keys", "-t", `${SESSION}.0`, "M-1"]);
	sleep(3500);
	const inDetail = (text) => !text.includes("❯") && !text.includes("torus fleet —");
	if (!inDetail(paneText(`${SESSION}.0`))) {
		// Fallback: reopen the list and walk into detail with the keyboard.
		tmux(["send-keys", "-t", `${SESSION}.0`, "Escape"]);
		sleep(600);
		tmux(["send-keys", "-t", `${SESSION}.0`, "M-t"]);
		waitFor(`${SESSION}.0`, "❯", 10_000, "fleet browser list (retry)");
		tmux(["send-keys", "-t", `${SESSION}.0`, "j"]);
		sleep(600);
		tmux(["send-keys", "-t", `${SESSION}.0`, "Enter"]);
		sleep(3000);
	}
	if (!inDetail(paneText(`${SESSION}.0`))) {
		console.error(
			`site: pane never entered fleet detail; screen was:\n${paneText(`${SESSION}.0`)}`,
		);
		throw new Error("fleet detail view");
	}
	capture(`${SESSION}.0`, "fleet-detail");

	// Let the dispatch settle before teardown so the child exits cleanly.
	const deadline = Date.now() + 240_000;
	while (delegationPane() && Date.now() < deadline) sleep(3000);

	writeFileSync(
		resolve(outDir, "captures.json"),
		`${JSON.stringify(
			{
				capturedAt: new Date().toISOString(),
				geometry: [WIDTH, HEIGHT],
				scenes: ["statusline-fleet", "delegation-pane", "fleet-list", "fleet-detail", "roster"],
			},
			null,
			"\t",
		)}\n`,
	);
	console.log("site: wrote captures.json");
	ok = true;
} catch (error) {
	console.error(`site: ${error.message}`);
} finally {
	teardown(stateDir, ok);
}
