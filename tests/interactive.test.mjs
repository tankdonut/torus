import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const {
	DETACH_KEY,
	PtyOverlay,
	buildPtyCommand,
	createTerm,
	headlessRun,
	isDetachKey,
	settleTerm,
	termTail,
	unwrapPaste,
} = await import("../extensions/interactive/index.ts");

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function stubTheme() {
	return {
		fg: (_color, text) => text,
	};
}

function stubTui() {
	return { requestRender: () => {} };
}

function stubChild() {
	const stdout = new EventEmitter();
	const written = [];
	const child = new EventEmitter();
	child.stdout = stdout;
	child.killed = false;
	child.kill = (_signal) => {
		child.killed = true;
		child.emit("exit", null);
		return true;
	};
	child.stdin = { writable: true, write: (data) => written.push(data) };
	return { child, written };
}

function mountOverlay(child, timeoutMs = 60_000) {
	let resolveDone;
	const donePromise = new Promise((resolve) => {
		resolveDone = resolve;
	});
	const overlay = new PtyOverlay(
		stubTui(),
		stubTheme(),
		(tail) => resolveDone(tail),
		child,
		"python3 -i",
		timeoutMs,
		24,
		80,
	);
	return { overlay, donePromise };
}

test("emulator: carriage-return progress redraws collapse to final text", async () => {
	const term = createTerm(24, 80);
	term.write(
		"Reading package lists... 0%\rReading package lists... 47%\rReading package lists... Done\r\n",
	);
	await settleTerm(term);
	const tail = termTail(term);
	assert.match(tail, /Reading package lists\.\.\. Done/);
	assert.doesNotMatch(tail, /0%|47%/);
	term.dispose();
});

test("emulator: erase-line prompt repaint replaces the question", async () => {
	const term = createTerm(24, 80);
	term.write("? Authenticate Git with your GitHub credentials? (Y/n)");
	term.write("\r\x1b[2K? Authenticate Git with your GitHub credentials? Yes\r\n");
	await settleTerm(term);
	const tail = termTail(term);
	assert.match(tail, /credentials\? Yes/);
	assert.doesNotMatch(tail, /\(Y\/n\)/);
	term.dispose();
});

test("emulator: escape sequences split across chunks parse correctly", async () => {
	const term = createTerm(24, 80);
	term.write("spin\x1b[");
	term.write("Kdone\r\n");
	await settleTerm(term);
	assert.equal(termTail(term), "spindone");
	term.dispose();
});

test("emulator: cursor-up rewrites rewrite the addressed row", async () => {
	const term = createTerm(24, 80);
	term.write("line1\r\nline2\r\nline3\r\n");
	term.write("\x1b[2A\x1b[Krewrote");
	await settleTerm(term);
	assert.deepEqual(termTail(term).split("\n"), ["line1", "rewrote", "line3"]);
	term.dispose();
});

test("termTail trims outer blank rows and caps the character budget", async () => {
	const term = createTerm(24, 80);
	term.write("\r\n\r\npayload\r\n\r\n");
	await settleTerm(term);
	assert.equal(termTail(term), "payload");
	term.write(`${"x".repeat(10_000)}END\r\n`);
	await settleTerm(term);
	const capped = termTail(term);
	assert.ok(capped.length <= 4_001, `tail too long: ${capped.length}`);
	assert.ok(capped.endsWith("END"));
	term.dispose();
});

test("headlessRun: simple command under script PTY", async () => {
	const run = await headlessRun("printf torus-interactive-ok", 30_000);
	assert.equal(run.timedOut, false);
	assert.equal(run.ok, true);
	assert.match(run.text, /torus-interactive-ok/);
});

test("headlessRun: failing command reports not-ok", async () => {
	const run = await headlessRun("exit 3", 30_000);
	assert.equal(run.ok, false);
	assert.equal(run.timedOut, false);
});

test("headlessRun: colors are consumed and CR progress collapses", async () => {
	const run = await headlessRun("printf 'A\\033[31mRED\\033[0mB\\007'", 30_000);
	assert.equal(run.ok, true);
	assert.equal(run.text, "AREDB");
	const progress = await headlessRun("printf 'fetch... 0%%\\rfetch... Done\\n'", 30_000);
	assert.equal(progress.text, "fetch... Done");
});

test("unwrapPaste strips bracketed-paste markers only", () => {
	assert.equal(unwrapPaste("\x1b[200~ghp_token\x1b[201~"), "ghp_token");
	assert.equal(unwrapPaste("\x1b[200~multi\x1b[201~\x1b[200~paste\x1b[201~"), "multipaste");
	assert.equal(unwrapPaste("plain typing\n"), "plain typing\n");
	assert.equal(unwrapPaste("\x1b[A"), "\x1b[A");
});

test("isDetachKey matches legacy and kitty encodings of ctrl-]", () => {
	assert.equal(isDetachKey("\x1d"), true);
	assert.equal(isDetachKey("\x1b[29;5u"), true);
	assert.equal(isDetachKey("\x1b[29;5:2u"), true);
	assert.equal(isDetachKey("]"), false);
	assert.equal(isDetachKey("\x1b[A"), false);
	assert.equal(isDetachKey("x"), false);
});

test("buildPtyCommand prepends a winsize when known", () => {
	assert.equal(
		buildPtyCommand("gh auth login", 40, 120),
		"stty rows 40 cols 120 2>/dev/null; gh auth login",
	);
	assert.equal(buildPtyCommand("gh auth login", null, 120), "gh auth login");
	assert.equal(buildPtyCommand("gh auth login", 40, null), "gh auth login");
});

test("PtyOverlay: streams emulated output, forwards raw input, detach returns tail", async () => {
	const { child, written } = stubChild();
	const { overlay, donePromise } = mountOverlay(child);

	child.stdout.emit("data", Buffer.from("Python 3.12 REPL\n>>> "));
	overlay.handleInput("print(1+1)\n");
	assert.deepEqual(written, ["print(1+1)\n"]);

	overlay.handleInput(DETACH_KEY);
	const resolved = await donePromise;
	assert.match(resolved, /REPL/);
	assert.match(resolved, />>>/);
});

test("PtyOverlay: render shows emulated repaint without control sequences", async () => {
	const { child } = stubChild();
	const { overlay } = mountOverlay(child);
	child.stdout.emit("data", Buffer.from("\x1b[31mred\x1b[0m \x1b]11;?\x1b\\\x1b[6n\x07plain\r\n"));
	child.stdout.emit("data", Buffer.from("progress 10%\rprogress done\r\n"));
	await tick();
	const lines = overlay.render(80);
	for (const line of lines) {
		assert.ok(!/\x1b|\x07/.test(line), `control chars leaked: ${JSON.stringify(line)}`);
	}
	assert.ok(lines.some((line) => line.includes("red plain")));
	assert.ok(lines.some((line) => line.includes("progress done")));
	assert.ok(!lines.some((line) => line.includes("10%")));
	overlay.dispose();
});

test("PtyOverlay: unwraps bracketed paste before forwarding", () => {
	const { child, written } = stubChild();
	const { overlay } = mountOverlay(child);
	overlay.handleInput("\x1b[200~ghp_AbCdEf\x1b[201~");
	assert.deepEqual(written, ["ghp_AbCdEf"]);
	overlay.handleInput("\r");
	assert.deepEqual(written, ["ghp_AbCdEf", "\r"]);
	overlay.dispose();
});

test("PtyOverlay: kitty-encoded ctrl-] detaches", async () => {
	const { child, written } = stubChild();
	const { overlay, donePromise } = mountOverlay(child);
	child.stdout.emit("data", Buffer.from("output"));
	overlay.handleInput("\x1b[29;5u");
	const resolved = await donePromise;
	assert.match(resolved, /output/);
	assert.deepEqual(written, []);
});

test("PtyOverlay: child exit auto-completes with exit note", async () => {
	const { child } = stubChild();
	const { donePromise } = mountOverlay(child);
	child.stdout.emit("data", Buffer.from("bye"));
	child.emit("exit", 0);
	const resolved = await donePromise;
	assert.match(resolved, /child exited \(0\)/);
});

test("PtyOverlay: timeout notes the reason and kills the child", async () => {
	const { child } = stubChild();
	const { donePromise } = mountOverlay(child, 5);
	await tick(40);
	assert.ok(child.killed);
	const resolved = await donePromise;
	assert.match(resolved, /timed out after 0s/);
	assert.match(resolved, /child exited \(null\)/);
});

test("PtyOverlay: survey-style Y/n prompt round-trip under a real PTY", {
	timeout: 30_000,
}, async () => {
	const program = [
		"bash -c '",
		'printf "? Authenticate Git with your GitHub credentials? (Y/n) "',
		"while :; do",
		"  IFS= read -rsn1 KEY",
		'  case "$KEY" in',
		'    y|Y) printf "\\r\\033[2K? Authenticate Git with your GitHub credentials? \\033[32mY\\033[0mes\\r\\n"; exit 0 ;;',
		"    *) exit 9 ;;",
		"  esac",
		"done",
		"'",
	].join("\n");
	const child = spawn("script", ["-qec", buildPtyCommand(program, 24, 120), "/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});
	const { overlay, donePromise } = mountOverlay(child);
	let sawPrompt = false;
	for (let i = 0; i < 50 && !sawPrompt; i++) {
		await tick(100);
		sawPrompt = overlay
			.render(120)
			.slice(3, -2)
			.some((line) => line.includes("(Y/n)"));
	}
	assert.ok(sawPrompt, "prompt never rendered");
	overlay.handleInput("y");
	const resolved = await donePromise;
	assert.match(resolved, /credentials\? Yes/);
	assert.doesNotMatch(resolved, /\(Y\/n\)/);
	assert.match(resolved, /child exited \(0\)/);
});
