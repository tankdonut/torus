import assert from "node:assert/strict";
import { test } from "node:test";

const { RpcChild } = await import("../extensions/rpc.ts");

const CAP = 1024 * 1024;

test("stdout buffer is capped: newline-free garbage cannot grow it unbounded", async () => {
	const child = new RpcChild(
		process.execPath,
		["-e", "process.stdout.write('x'.repeat(2 * CAP)); setTimeout(() => process.exit(0), 200);"],
		process.cwd(),
		{},
	);
	await child.exited;
	assert.ok(child.buffered <= CAP, `buffered ${child.buffered} exceeds cap ${CAP}`);
});

test("a real response after capped garbage still resolves the pending send", async () => {
	const child = new RpcChild(
		process.execPath,
		[
			"-e",
			`process.stdout.write('x'.repeat(2 * ${CAP})); process.stdout.write('\\n' + JSON.stringify({type:'response',id:'torus-1',ok:1}) + '\\n'); setInterval(()=>{},1000);`,
		],
		process.cwd(),
		{},
	);
	const response = await child.getState();
	assert.equal(response["ok"], 1);
	child.kill();
	assert.equal(typeof (await child.exited), "number");
});

test("steerable is true live, false the instant kill() is called (dead-child race window)", async () => {
	const child = new RpcChild(
		process.execPath,
		["-e", "setInterval(()=>{},1000);"],
		process.cwd(),
		{},
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(child.steerable, true);
	child.kill();
	assert.equal(child.steerable, false);
	await child.exited;
	assert.equal(child.steerable, false);
});

test("steerable is false once the child exited on its own", async () => {
	const child = new RpcChild(process.execPath, ["-e", "process.exit(0)"], process.cwd(), {});
	await child.exited;
	assert.equal(child.steerable, false);
});
