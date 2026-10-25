import assert from "node:assert/strict";
import test from "node:test";
import { extractPermissionMode } from "../runtime/bin/permission-mode.mjs";

test("equals spelling: --permission-mode=auto yields mode auto and strips the flag", () => {
	const result = extractPermissionMode(["--permission-mode=auto", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "auto" });
});

test("two-token spelling: --permission-mode auto consumes the value token", () => {
	const result = extractPermissionMode(["--permission-mode", "auto", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "auto" });
});

test("value default is accepted for both spellings", () => {
	assert.deepEqual(extractPermissionMode(["--permission-mode=default"]), {
		argv: [],
		mode: "default",
	});
	assert.deepEqual(extractPermissionMode(["--permission-mode", "default"]), {
		argv: [],
		mode: "default",
	});
});

test("flag anywhere in argv: start, middle, and end positions all work", () => {
	const middle = extractPermissionMode(["--model", "big", "--permission-mode=auto", "--version"]);
	assert.deepEqual(middle, { argv: ["--model", "big", "--version"], mode: "auto" });
	const end = extractPermissionMode(["--version", "--permission-mode=auto"]);
	assert.deepEqual(end, { argv: ["--version"], mode: "auto" });
	const twoTokenEnd = extractPermissionMode(["--version", "--permission-mode", "auto"]);
	assert.deepEqual(twoTokenEnd, { argv: ["--version"], mode: "auto" });
});

test("repeated flags: the last occurrence wins", () => {
	const result = extractPermissionMode(["--permission-mode=auto", "--permission-mode=default"]);
	assert.deepEqual(result, { argv: [], mode: "default" });
	assert.deepEqual(
		extractPermissionMode(["--permission-mode", "default", "--permission-mode=auto"]),
		{
			argv: [],
			mode: "auto",
		},
	);
});

test("unknown value: error names the bad value and both valid ones, mode undefined", () => {
	const result = extractPermissionMode(["--permission-mode=bogus", "--version"]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /bogus/);
	assert.match(result.error ?? "", /auto/);
	assert.match(result.error ?? "", /default/);
});

test("an invalid occurrence wins over valid ones; the first error is reported", () => {
	const result = extractPermissionMode([
		"--permission-mode=auto",
		"--permission-mode=nope",
		"--permission-mode=worse",
	]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /nope/);
	assert.doesNotMatch(result.error ?? "", /worse/);
	assert.deepEqual(result.argv, []);
});

test("both spellings stripped in one argv, other args keep order", () => {
	const result = extractPermissionMode([
		"--permission-mode=auto",
		"@file.txt",
		"--permission-mode",
		"default",
		"--",
		"-x",
	]);
	assert.deepEqual(result, { argv: ["@file.txt", "--", "-x"], mode: "default" });
});

test("no flag: passthrough identity (same array reference, no mode, no error)", () => {
	const argv = ["serve", "--help", "--permission"];
	const result = extractPermissionMode(argv);
	assert.equal(result.argv, argv);
	assert.equal(result.mode, undefined);
	assert.equal(result.error, undefined);
	assert.deepEqual(extractPermissionMode([]), { argv: [] });
});

test("case-sensitive: --permission-mode=Auto is an error", () => {
	const result = extractPermissionMode(["--permission-mode=Auto"]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /Auto/);
	assert.match(result.error ?? "", /auto/);
});

test("final token with no value: error, not silent passthrough", () => {
	const equals = extractPermissionMode(["--permission-mode"]);
	assert.equal(equals.mode, undefined);
	assert.match(equals.error ?? "", /missing value/);
	assert.match(equals.error ?? "", /auto/);
	assert.deepEqual(equals.argv, []);
});

test("empty value after = is an error naming it", () => {
	const result = extractPermissionMode(["--permission-mode="]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /unknown value/);
});

test("similar flags are not the flag: --permission-modex=auto passes through", () => {
	const result = extractPermissionMode(["--permission-modex=auto"]);
	assert.equal(result.mode, undefined);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.argv, ["--permission-modex=auto"]);
});

test("equals spelling: --permission-mode=bypass yields mode bypass and strips the flag", () => {
	const result = extractPermissionMode(["--permission-mode=bypass", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "bypass" });
});

test("two-token spelling: --permission-mode bypass consumes the value token", () => {
	const result = extractPermissionMode(["--permission-mode", "bypass", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "bypass" });
});

test("repeated flags: a later default overrides an earlier bypass", () => {
	const result = extractPermissionMode([
		"--permission-mode=bypass",
		"--permission-mode",
		"default",
	]);
	assert.deepEqual(result, { argv: [], mode: "default" });
});

test("unknown value error names all three valid modes", () => {
	const result = extractPermissionMode(["--permission-mode=yolo"]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /"auto", "default", or "bypass"/);
});
