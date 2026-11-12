/**
 * Regenerates the real TUI captures rendered on the landing page.
 *
 * Boots the actual torus TUI inside a fixed-height tmux session, delegates a
 * small task to an explorer agent, and snapshots the pane (with SGR colors)
 * as the run progresses. Each theme gets a pass: the engine theme flips
 * in place (the agent settings' theme key — saved and restored around the
 * run — plus /reload), and because a rebind terminalizes live delegations,
 * the roster captures bookend a flip on a quiet session while the live-run
 * scenes (strip, list, detail, team) re-drive their runs per pass at the
 * same phase. Artifacts land in src/tui/<theme>/*.ans plus a
 * captures.json manifest, all committed; re-run when a surface changes:
 *
 *     npm run -w site capture
 *
 * Scenes render at MAIN_COLS columns: the engine pane (not the window) is
 * pinned to that width, because side panes from live delegations or team
 * members otherwise shrink it run by run; the pinned width is what fills
 * the site's terminal frame without horizontal scrolling.
 *
 * Costs a few cents: the explorer dispatch runs on a flash-tier model and
 * the lead session takes no model turns (slash dispatches are direct tool
 * calls). TORUS_DREAMING=0 keeps the idle dreamer from spawning mid-capture.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(siteRoot, "..");
const tuiRoot = resolve(siteRoot, "src", "tui");

const SESSION = "torus-site-capture";
// The column count every scene renders at. The landing's terminal frame
// shows ~138 columns at desktop width; 136 fills it while keeping a sliver
// of margin at 1280px viewports.
const MAIN_COLS = 136;
const HEIGHT = 32;
// The task must start fast (the first turn must land inside the harness's
// ~10s no-work window) and run long (the fleet scenes span ~70s of theme
// flips while the explorer is still working); sequencing two files does
// both.
const DISPATCH =
	"use grep to list every exported symbol in extensions/fsutil.ts with a one-line summary of each, then do the same for extensions/registry.ts";
const TEAM_MESSAGE = [
	"Create a persistent team with exactly two members: handle @scout on the builder agent and handle @index on the librarian agent.",
	"Shared objective: catalog the site's docs pages.",
	"Send @scout one instruction: read site/src/pages/index.astro and outline its section structure. Send @index one instruction: list every markdown file under docs/ with its title. Then reply with only: team ready",
].join(" ");

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
const paneWidth = () =>
	Number.parseInt(
		tmux(["display-message", "-p", "-t", `${SESSION}.0`, "#{pane_width}"]).stdout ?? "",
		10,
	);
const paneGeometry = () =>
	(
		tmux(["display-message", "-p", "-t", `${SESSION}.0`, "#{pane_width} #{pane_height}"]).stdout ??
		"0 0"
	)
		.trim()
		.split(" ")
		.map(Number);

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
const capture = (pane, name, outDir) => {
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

/** Pin the ENGINE pane (index 0) to `cols` columns. Side panes opened by
 * live delegations or team members redistribute window resizes differently
 * per run, so the pane itself is sized and verified, with the window
 * adjusted by any shortfall a sibling pane constrains. */
function setMainPaneWidth(cols) {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const panes = (tmux(["list-panes", "-t", SESSION, "-F", "#{pane_id}"]).stdout ?? "")
			.trim()
			.split("\n");
		if (panes.length === 1) {
			// A lone pane IS the window; resize-pane cannot move it, so size the
			// window directly.
			tmux(["resize-window", "-t", SESSION, "-x", String(cols)]);
		} else {
			tmux(["resize-pane", "-t", `${SESSION}.0`, "-x", String(cols)]);
			const actual = paneWidth();
			if (actual !== cols) {
				// A sibling pane constrains the target; grow the window by the
				// shortfall and pin again.
				const window = Number.parseInt(
					tmux(["display-message", "-p", "-t", SESSION, "#{window_width}"]).stdout ?? "0",
					10,
				);
				tmux(["resize-window", "-t", SESSION, "-x", String(window + (cols - actual))]);
				tmux(["resize-pane", "-t", `${SESSION}.0`, "-x", String(cols)]);
			}
		}
		sleep(400);
		if (paneWidth() === cols) return;
	}
	throw new Error(`engine pane stuck at ${paneWidth()} cols (wanted ${cols})`);
}

let stateDir = "";
let geometry = [0, 0];

// The engine's theme key must flip in the REAL agent dir: an isolated
// PI_CODING_AGENT_DIR would hide provider credentials from dispatched
// children (they inherit the env) and every delegation dies authless. The
// original settings bytes are captured up front and restored in teardown,
// win or fail; flips merge into whatever the operator has there.
const agentSettingsPath = resolve(
	process.env["PI_CODING_AGENT_DIR"] ?? resolve(homedir(), ".pi", "agent"),
	"settings.json",
);
const settingsOriginal = existsSync(agentSettingsPath)
	? readFileSync(agentSettingsPath, "utf8")
	: null;

function teardown(stateDirArg, success) {
	tmux(["send-keys", "-t", `${SESSION}.0`, "/exit", "Enter"]);
	sleep(1500);
	tmux(["kill-session", "-t", SESSION]);
	rmSync(stateDirArg, { recursive: true, force: true });
	restoreAgentSettings();
	if (!success) {
		console.error("site: capture run FAILED; artifacts above (if any) are partial");
		process.exitCode = 1;
	}
}

const boot = () => {
	stateDir = mkdtempSync(resolve(tmpdir(), "torus-site-capture-"));
	tmux([
		"new-session",
		"-d",
		"-s",
		SESSION,
		"-x",
		String(MAIN_COLS),
		"-y",
		String(HEIGHT),
		"-c",
		repoRoot,
		// The capture's statusline must show the provider actually serving
		// the session: zai's quota is exhausted while this capture was taken,
		// so the boot pins the model to the chain's fallback leg and the
		// provider highlight lands on opencode-go.
		`env TORUS_STATE_DIR=${stateDir} TORUS_DREAMING=0 ./runtime/bin/torus.mjs --use-theme dark --model opencode-go/glm-5.3-flash`,
	]);
};

/** Flip the engine theme in place: merge `theme` into the real agent
 * settings and /reload. The rebind repaints the whole session in the new
 * palette; open overlays close, so scenes reopen per capture. The wait
 * budget is generous because the torus statusline chip's reappearance after
 * a rebind is slow and varies (observed between a few and 90+ seconds) —
 * capturing before it returns would break dark/light parity of the
 * statusline. The terminal color-scheme report (CSI ? 997) was tried and
 * does not flip the theme in a detached tmux pane; /reload is the mechanism
 * that works. */
const setEngineTheme = (theme) => {
	tmux(["send-keys", "-t", `${SESSION}.0`, "Escape"]);
	sleep(400);
	const merged = JSON.parse(settingsOriginal ?? "{}");
	merged.theme = theme;
	writeFileSync(agentSettingsPath, `${JSON.stringify(merged, null, "\t")}\n`);
	tmux(["send-keys", "-t", `${SESSION}.0`, "/reload", "Enter"]);
	waitFor(`${SESSION}.0`, "torus · leader", 150_000, `theme switch to ${theme}`);
	sleep(1500);
};

const restoreAgentSettings = () => {
	if (settingsOriginal === null) {
		if (existsSync(agentSettingsPath)) unlinkSync(agentSettingsPath);
		return;
	}
	writeFileSync(agentSettingsPath, settingsOriginal);
};

const closeOverlay = () => {
	tmux(["send-keys", "-t", `${SESSION}.0`, "Escape"]);
	sleep(600);
};

const inDetail = (text) => text.includes("[s] steer");

/** M-1 is the strip slot shortcut: it opens the first running agent's
 * detail directly. The detail head truncates at the pane width, so the
 * reliable marker is the detail-only [s] steer footer; the list head
 * shows "↑↓ move" instead. */
const openFleetDetail = () => {
	closeOverlay();
	tmux(["send-keys", "-t", `${SESSION}.0`, "M-1"]);
	sleep(3500);
	if (!inDetail(paneText(`${SESSION}.0`))) {
		// Fallback: reopen the list and walk into detail with the keyboard.
		closeOverlay();
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
};

/** Dispatch the explorer and wait out the harness's ~10s no-work kill:
 * provider runs flake into it (a new "✗ explorer failed" / torus:failed
 * marker in the transcript), and re-dispatching beats capturing a dead
 * run's fleet. Failures from earlier, terminalized runs (the theme flip
 * kills the live one) are counted out. */
function dispatchExplorer() {
	const failures = () => paneText(`${SESSION}.0`).split("torus:failed").length - 1;
	const before = failures();
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		tmux(["send-keys", "-t", `${SESSION}.0`, `/explorer ${DISPATCH}`, "Enter"]);
		// The pinned strip renders "fleet N · <segments> · alt+t all" once the
		// delegation registers; "alt+t all" is the strip's permanent tail chip.
		waitFor(`${SESSION}.0`, "alt+t all", 30_000, "fleet strip after dispatch");
		sleep(12_000);
		if (failures() === before) return;
		if (attempt === 3) throw new Error("explorer dispatch failed three times");
		console.log("site: dispatch died, retrying");
	}
}

function runDispatchScenes() {
	mkdirSync(resolve(tuiRoot, "dark"), { recursive: true });
	mkdirSync(resolve(tuiRoot, "light"), { recursive: true });
	tmux(["kill-session", "-t", SESSION]);

	const stripUp = () => waitFor(`${SESSION}.0`, "alt+t all", 20_000, "fleet strip");
	const openList = () => {
		closeOverlay();
		// tmux key names use the M- prefix for Alt; "Alt+t" would be typed
		// literally into the chat editor. The overlay list renders a ❯ pointer
		// on the selected row; the always-on strip never does.
		tmux(["send-keys", "-t", `${SESSION}.0`, "M-t"]);
		waitFor(`${SESSION}.0`, "❯", 10_000, "fleet browser list");
		sleep(1500);
	};
	// One pass per theme over the live-run scenes, each in its OWN session on
	// a fresh dispatch: the flip's /reload terminalizes the live delegation
	// (orphan cleanup), so a single run cannot span both themes, and a shared
	// session would show the terminalized run's stale row in the second
	// pass's fleet list.
	const fleetPass = (theme) => {
		dispatchExplorer();
		// The split pane takes its width, so re-pin the engine pane.
		setMainPaneWidth(MAIN_COLS);
		geometry = paneGeometry();
		stripUp();
		capture(`${SESSION}.0`, "statusline-fleet", resolve(tuiRoot, theme));
		openList();
		capture(`${SESSION}.0`, "fleet-list", resolve(tuiRoot, theme));
		openFleetDetail();
		// Soft phase settle: prefer capturing with tool output streaming (the
		// dispatch asks for grep, so "$ grep" rows are the usual marker), but a
		// run that picks different tools still captures after the wait instead
		// of failing the pass.
		try {
			waitFor(`${SESSION}.0`, /\$ (grep|read|rg)/, 30_000, "explorer transcript output");
		} catch {
			console.log("site: detail phase marker absent, capturing as-is");
		}
		capture(`${SESSION}.0`, "fleet-detail", resolve(tuiRoot, theme));
		closeOverlay();
	};

	// Session 1: the stateless roster scene in both themes around one flip,
	// then the light fleet pass riding a fresh dispatch.
	boot();
	waitFor(`${SESSION}.0`, "torus · leader", 60_000, "TUI boot (statusline)");
	setMainPaneWidth(MAIN_COLS);
	const openRoster = () => {
		tmux(["send-keys", "-t", `${SESSION}.0`, "/roster", "Enter"]);
		waitFor(`${SESSION}.0`, "concurrency caps", 30_000, "roster output");
		sleep(1000);
	};
	openRoster();
	capture(`${SESSION}.0`, "roster", resolve(tuiRoot, "dark"));
	setEngineTheme("light");
	openRoster();
	capture(`${SESSION}.0`, "roster", resolve(tuiRoot, "light"));
	// Let the dispatch settle before teardown so the child exits cleanly.
	const settle = () => {
		const deadline = Date.now() + 240_000;
		while (delegationPane() && Date.now() < deadline) sleep(3000);
		teardown(stateDir, true);
	};
	fleetPass("light");
	settle();

	// Session 2: the dark fleet pass, no flip needed (dark is the boot
	// theme).
	boot();
	waitFor(`${SESSION}.0`, "torus · leader", 60_000, "TUI boot (fleet pass)");
	fleetPass("dark");
	settle();
}

function runTeamScene() {
	// Team mode runs in a fresh session: in the dispatch session the
	// explorer's deferred result turn owns the lead, and the team message
	// queues behind it.
	boot();
	waitFor(`${SESSION}.0`, "torus · leader", 60_000, "TUI boot (team session)");
	tmux(["send-keys", "-t", `${SESSION}.0`, TEAM_MESSAGE, "Enter"]);
	// The strip carries member rows once they run; its permanent "alt+t all"
	// tail is the marker (the ⧉ badge is browser-only now, and the prompt
	// itself echoes the handles, so "@scout" would match the sent message).
	waitFor(`${SESSION}.0`, "alt+t all", 180_000, "team members to spawn");
	// Member engines open their own side panes; re-pin the engine pane.
	setMainPaneWidth(MAIN_COLS);
	const openTeamBrowser = () => {
		closeOverlay();
		// Open the browser while members still run: alt+t is a no-op once
		// every member idles. Members render as regular fleet rows carrying
		// the agent name in parens ("@scout (builder)").
		tmux(["send-keys", "-t", `${SESSION}.0`, "M-t"]);
		waitFor(`${SESSION}.0`, "(builder)", 15_000, "fleet browser team rows");
		sleep(4000);
	};
	openTeamBrowser();
	capture(`${SESSION}.0`, "team", resolve(tuiRoot, "dark"));
	// The flip's /reload terminalizes the running members like any live
	// delegation; persistent teams re-engage a member on mail, so nudge each
	// one back to work for the light pass.
	setEngineTheme("light");
	tmux([
		"send-keys",
		"-t",
		`${SESSION}.0`,
		"@scout read site/src/lib/ansi.mjs and reply with a one-line summary",
		"Enter",
	]);
	sleep(3000);
	tmux([
		"send-keys",
		"-t",
		`${SESSION}.0`,
		"@index read site/src/lib/code-copy.mjs and reply with a one-line summary",
		"Enter",
	]);
	waitFor(`${SESSION}.0`, "alt+t all", 180_000, "team members to re-run");
	// The respawned member engines re-open their side panes; re-pin again.
	setMainPaneWidth(MAIN_COLS);
	openTeamBrowser();
	capture(`${SESSION}.0`, "team", resolve(tuiRoot, "light"));
	teardown(stateDir, true);
}

if (run("test -d node_modules/@earendil-works/pi-coding-agent").status !== 0) {
	console.error("site: engine missing; run npm install at the repo root first");
	process.exit(1);
}

let ok = false;
try {
	runDispatchScenes();
	runTeamScene();
	writeFileSync(
		resolve(tuiRoot, "captures.json"),
		`${JSON.stringify(
			{
				capturedAt: new Date().toISOString(),
				geometry,
				themes: ["dark", "light"],
				scenes: ["statusline-fleet", "fleet-list", "fleet-detail", "team", "roster"],
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
	// A completed flow tore itself down; only a failed run leaves a session.
	if (!ok) teardown(stateDir, false);
}
