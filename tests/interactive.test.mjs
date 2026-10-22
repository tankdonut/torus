import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const { DETACH_KEY, capRing, ringTail, headlessRun } = await import(
	"../extensions/interactive/index.ts"
);
const { PtyOverlay, buildPtyCommand, isDetachKey, stripTerminalControls, unwrapPaste } =
	await import("../extensions/interactive/index.ts");

test("capRing keeps the tail under the byte cap", () => {
	const big = "x".repeat(70_000);
	const capped = capRing("", big);
	assert.equal(capped.length, 64_000);
	assert.ok(capped.startsWith("x"));
	const withMark = capRing(capped, "TAIL");
	assert.ok(withMark.endsWith("TAIL"));
});

test("ringTail returns the requested suffix", () => {
	const ring = "0123456789";
	assert.equal(ringTail(ring, 4), "6789");
	assert.equal(ringTail(ring, 100), ring);
});

test("headlessRun: simple command under script PTY", () => {
	const run = headlessRun("printf torus-interactive-ok", 30_000);
	assert.equal(run.timedOut, false);
	assert.equal(run.ok, true);
	assert.match(run.text, /torus-interactive-ok/);
});

test("headlessRun: failing command reports not-ok", () => {
	const run = headlessRun("exit 3", 30_000);
	assert.equal(run.ok, false);
	assert.equal(run.timedOut, false);
});

test("headlessRun: control sequences are stripped from output", () => {
	const run = headlessRun("printf 'A\\033[31mRED\\033[0mB\\007'", 30_000);
	assert.equal(run.ok, true);
	assert.equal(run.text, "AREDB");
});

test("stripTerminalControls removes escape and C0 sequences", () => {
	assert.equal(stripTerminalControls("\x1b[31mRED\x1b[0m"), "RED");
	assert.equal(stripTerminalControls("\x1b[?25lhidden\x1b[?25h"), "hidden");
	assert.equal(stripTerminalControls("\x1b]11;?\x1b\\query"), "query");
	assert.equal(stripTerminalControls("before\x1b]0;title\x07after"), "beforeafter");
	assert.equal(stripTerminalControls("save\x1b7restore\x1b8"), "saverestore");
	assert.equal(stripTerminalControls("bell\x07gone"), "bellgone");
	assert.equal(stripTerminalControls("spin\rdone"), "spindone");
	assert.equal(stripTerminalControls("keep\ttab\nline"), "keep\ttab\nline");
	assert.equal(stripTerminalControls("charset\x1b(Bdone"), "charsetdone");
	const ghLike = "\x1b[0;33m!\x1b[0m First copy\x1b[6n";
	assert.equal(stripTerminalControls(ghLike), "! First copy");
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

function stubTheme() {
	return {
		fg: (_color, text) => text,
	};
}

function stubTui() {
	const renders = [];
	return { requestRender: () => renders.push(1), renders };
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

function makeOverlay(child, done, timeoutMs = 60_000) {
	return new PtyOverlay(stubTui(), stubTheme(), done, child, "python3 -i", timeoutMs);
}

test("PtyOverlay: streams output, forwards raw input, detach returns tail", async () => {
	const { child, written } = stubChild();
	let resolved;
	const overlay = makeOverlay(child, (tail) => {
		resolved = tail;
	});

	child.stdout.emit("data", Buffer.from("Python 3.12 REPL\n>>> "));
	overlay.handleInput("print(1+1)\n");
	assert.deepEqual(written, ["print(1+1)\n"]);

	overlay.handleInput(DETACH_KEY);
	assert.match(resolved ?? "", /REPL/);
	assert.match(resolved ?? "", />>>/);

	const lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("tty")));
});

test("PtyOverlay: render contains no control sequences", () => {
	const { child } = stubChild();
	const overlay = makeOverlay(child, () => {});
	child.stdout.emit("data", Buffer.from("\x1b[31mred\x1b[0m \x1b]11;?\x1b\\\x1b[6n\x07plain\r\n"));
	const lines = overlay.render(80);
	for (const line of lines) {
		assert.ok(!/\x1b|\x07/.test(line), `control chars leaked: ${JSON.stringify(line)}`);
	}
	assert.ok(lines.some((line) => line.includes("red plain")));
	overlay.dispose();
});

test("PtyOverlay: unwraps bracketed paste before forwarding", () => {
	const { child, written } = stubChild();
	const overlay = makeOverlay(child, () => {});
	overlay.handleInput("\x1b[200~ghp_AbCdEf\x1b[201~");
	assert.deepEqual(written, ["ghp_AbCdEf"]);
	overlay.handleInput("\r");
	assert.deepEqual(written, ["ghp_AbCdEf", "\r"]);
	overlay.dispose();
});

test("PtyOverlay: kitty-encoded ctrl-] detaches", () => {
	const { child, written } = stubChild();
	let resolved;
	const overlay = makeOverlay(child, (tail) => {
		resolved = tail;
	});
	child.stdout.emit("data", Buffer.from("output"));
	overlay.handleInput("\x1b[29;5u");
	assert.match(resolved ?? "", /output/);
	assert.deepEqual(written, []);
});

test("PtyOverlay: child exit auto-completes with exit note", () => {
	const { child } = stubChild();
	let resolved;
	makeOverlay(child, (tail) => {
		resolved = tail;
	});
	child.stdout.emit("data", Buffer.from("bye"));
	child.emit("exit", 0);
	assert.match(resolved ?? "", /child exited \(0\)/);
});

test("PtyOverlay: timeout notes the reason and kills the child", async () => {
	const { child } = stubChild();
	let resolved;
	makeOverlay(
		child,
		(tail) => {
			resolved = tail;
		},
		5,
	);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.ok(child.killed);
	assert.match(resolved ?? "", /timed out after 0s/);
	assert.match(resolved ?? "", /child exited \(null\)/);
});
