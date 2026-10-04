import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const { DETACH_KEY, capRing, ringTail, headlessRun } = await import(
	"../extensions/interactive/index.ts"
);
const { PtyOverlay } = await import("../extensions/interactive/index.ts");

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
	child.stdin = { writable: true, write: (data) => written.push(data) };
	return { child, written };
}

test("PtyOverlay: streams output, forwards raw input, detach returns tail", async () => {
	const tui = stubTui();
	const { child, written } = stubChild();
	let resolved;
	const overlay = new PtyOverlay(
		tui,
		stubTheme(),
		(tail) => {
			resolved = tail;
		},
		child,
		"python3 -i",
	);

	child.stdout.emit("data", Buffer.from("Python 3.12 REPL\n>>> "));
	overlay.handleInput("print(1+1)\n");
	assert.deepEqual(written, ["print(1+1)\n"]);

	overlay.handleInput(DETACH_KEY);
	assert.match(resolved ?? "", /REPL/);
	assert.match(resolved ?? "", />>>/);

	const lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("tty")));
});

test("PtyOverlay: child exit auto-completes with exit note", () => {
	const tui = stubTui();
	const { child } = stubChild();
	let resolved;
	new PtyOverlay(
		tui,
		stubTheme(),
		(tail) => {
			resolved = tail;
		},
		child,
		"bash",
	);
	child.stdout.emit("data", Buffer.from("bye"));
	child.emit("exit", 0);
	assert.match(resolved ?? "", /child exited \(0\)/);
});
