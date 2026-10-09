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
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(path.join(tmpdir(), "torus-persona-state-"));
process.env["TORUS_HOME"] = home;

const { applyPersonaTheme } = await import("../extensions/persona-theme.ts");
const { personaFg } = await import("../extensions/ui/index.ts");
const prompts = await import("../extensions/prompts/index.ts");
const { projectStateDir } = await import("../extensions/fsutil.ts");
const { sessionFileExists } = await import("../extensions/sessions/index.ts");

const realTheme = new Theme(
	{ muted: "#888888", text: "#ffffff", thinkingXhigh: "#aaaaaa" },
	{ selectedBg: "#222222" },
	"dark",
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function makeUi() {
	const calls = [];
	let current = { live: "plain-object reconstruction" };
	return {
		calls,
		ctx: {
			ui: {
				get theme() {
					return current;
				},
				getTheme: (_name) => realTheme,
				setTheme: (t) => {
					current = t;
					calls.push(t);
					return { success: true };
				},
			},
		},
	};
}

test("persona theme applies on the next macrotask as a real-Theme override", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, "builder");
	// Synchronous window: the engine's post-rebind applyFromSettings still runs
	// here — nothing may be applied yet.
	assert.equal(calls.length, 0);
	await tick();
	assert.equal(calls.length, 1);
	const override = calls[0];
	assert.ok(override instanceof Theme);
	assert.equal(override.getThinkingBorderColor("thinking")("hello"), personaFg("builder", "hello"));
});

test("deferred apply lands after the engine's settings-theme reset (resume clobber)", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, "reviewer");
	// Simulate themeController.applyFromSettings() firing synchronously after
	// session_start handlers return — the /resume, /new, /fork, /reload path.
	ctx.ui.setTheme(realTheme);
	assert.equal(calls.length, 1);
	await tick();
	assert.equal(calls.length, 2);
	assert.ok(calls[1] instanceof Theme);
	assert.notEqual(calls[1], realTheme);
	assert.equal(calls[1].getThinkingBorderColor("thinking")("x"), personaFg("reviewer", "x"));
});

test("persona null restores the real base theme, deferred", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, null);
	assert.equal(calls.length, 0);
	await tick();
	assert.equal(calls.length, 1);
	assert.equal(calls[0], realTheme);
});

test("rapid persona switches keep last-call-wins order (timer FIFO)", async () => {
	const { calls, ctx } = makeUi();
	applyPersonaTheme(ctx, "builder");
	applyPersonaTheme(ctx, "looker");
	await tick();
	assert.equal(calls.length, 2);
	assert.equal(calls[1].getThinkingBorderColor("thinking")("x"), personaFg("looker", "x"));
});

// Per-project persona state: writes land under TORUS_HOME/state/--<cwd>--/persona/,
// legacy files still read until a write migrates them, and GC is orphan-only.
const dashedCwd = `--${process.cwd().replace(/^\/+/, "").replaceAll("/", "-")}--`;
const personaStateDir = () => path.join(projectStateDir(), "persona");
const personaFile = (id) => path.join(personaStateDir(), `${id}.json`);
const legacyPersonaFile = (id) => path.join(home, "persona", `${id}.json`);
const ageFile = (file, days) => {
	const aged = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	utimesSync(file, aged, aged);
};

test("persona write lands under the project state dir for the sandboxed cwd", () => {
	try {
		prompts.persistPersona("sess-a", "builder");
		const expected = path.join(home, "state", dashedCwd, "persona", "sess-a.json");
		assert.equal(personaFile("sess-a"), expected);
		assert.equal(existsSync(expected), true);
		assert.deepEqual(JSON.parse(readFileSync(expected, "utf8")), { persona: "builder" });
		assert.equal(prompts.restorePersona("sess-a"), "builder");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("legacy persona file still reads when no project-scoped file exists", () => {
	try {
		mkdirSync(path.join(home, "persona"), { recursive: true });
		writeFileSync(
			legacyPersonaFile("sess-legacy"),
			JSON.stringify({ persona: "reviewer" }),
			"utf8",
		);
		assert.equal(prompts.restorePersona("sess-legacy"), "reviewer");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("write migrates: project file written, legacy twin unlinked", () => {
	try {
		mkdirSync(path.join(home, "persona"), { recursive: true });
		writeFileSync(legacyPersonaFile("sess-mig"), JSON.stringify({ persona: "reviewer" }), "utf8");
		prompts.persistPersona("sess-mig", "looker");
		assert.equal(existsSync(personaFile("sess-mig")), true);
		assert.equal(existsSync(legacyPersonaFile("sess-mig")), false);
		assert.equal(prompts.restorePersona("sess-mig"), "looker");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("orphan GC prunes an aged orphan and keeps a fresh one (age floor)", () => {
	try {
		const sessionsRoot = path.join(home, "sessions");
		mkdirSync(sessionsRoot, { recursive: true });
		prompts.persistPersona("sess-gone", "builder");
		prompts.persistPersona("sess-fresh", "builder");
		ageFile(personaFile("sess-gone"), 40);

		const removed = prompts.prunePersonaOrphans(() => false);
		assert.equal(removed, 1);
		assert.equal(existsSync(personaFile("sess-gone")), false);
		assert.equal(existsSync(personaFile("sess-fresh")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("orphan GC keeps aged state for a live session (injected sessionFileExists)", () => {
	try {
		const sessionsRoot = path.join(home, "sessions");
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(path.join(sessionsRoot, "hit_sess-live.jsonl"), "", "utf8");
		prompts.persistPersona("sess-live", "builder");
		ageFile(personaFile("sess-live"), 40);

		const removed = prompts.prunePersonaOrphans((id) => sessionFileExists(id, sessionsRoot));
		assert.equal(removed, 0);
		assert.equal(existsSync(personaFile("sess-live")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unreadable sessions root keeps all persona state", () => {
	try {
		prompts.persistPersona("sess-null", "builder");
		ageFile(personaFile("sess-null"), 40);

		const missingRoot = path.join(home, "no-such-sessions-root");
		const removed = prompts.prunePersonaOrphans((id) => sessionFileExists(id, missingRoot));
		assert.equal(removed, 0);
		assert.equal(existsSync(personaFile("sess-null")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("orphan GC never deletes legacy-dir files", () => {
	try {
		mkdirSync(path.join(home, "persona"), { recursive: true });
		writeFileSync(legacyPersonaFile("sess-old"), JSON.stringify({ persona: "builder" }), "utf8");
		ageFile(legacyPersonaFile("sess-old"), 40);
		prompts.persistPersona("sess-orphan", "builder");
		ageFile(personaFile("sess-orphan"), 40);

		const removed = prompts.prunePersonaOrphans(() => false);
		assert.equal(removed, 1);
		assert.equal(existsSync(legacyPersonaFile("sess-old")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
