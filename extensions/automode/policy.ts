/**
 * torus — automode rules policy.
 *
 * Pure, engine-free decision core for automode command permissions:
 * user-configured rules (deny → ask → allow, Claude-Code-style prefix
 * patterns), a hardcoded critical-operation floor, and a
 * read-only fast path. Detection works at the bash grammar level: words
 * are unfolded (POSIX quoting and backslash escapes removed) and commands
 * are split on shell separators before any token comparison. Injectable
 * into any caller: no imports beyond what normalization needs, no engine
 * or IO.
 */

export type AutomodeVerdict = "allow" | "ask" | "deny";

export type Decision = {
	verdict: AutomodeVerdict | "failopen";
	source: "rule" | "askfloor" | "fastpath" | "cache" | "model" | "failopen" | "dialog";
	reason: string;
	model?: string;
	confidence?: number;
};

export type AutomodeRules = {
	allow?: string[];
	ask?: string[];
	deny?: string[];
};

/** Trim and collapse every whitespace run to a single space. */
export function normalizeCommand(raw: string): string {
	return raw.trim().replace(/\s+/g, " ");
}

/**
 * Claude-Code-style prefix pattern matching, performed on the normalized
 * command. A pattern ending in ` *` matches any command whose first words
 * equal the pattern's prefix, plus the bare prefix itself (`git push *`
 * matches `git push`). A trailing `:*` is an alias spelling of ` *`
 * (`git diff:*` ≡ `git diff *`). Every other pattern is an exact match.
 */
function matchesPattern(command: string, entry: string): boolean {
	const pattern = normalizeCommand(entry);
	if (pattern.endsWith(":*") || pattern.endsWith(" *")) {
		const prefix = pattern.slice(0, -2);
		return command === prefix || command.startsWith(`${prefix} `);
	}
	return command === pattern;
}

function wildcardPrefix(entry: string): string | undefined {
	const pattern = normalizeCommand(entry);
	if (pattern.endsWith(":*") || pattern.endsWith(" *")) {
		return pattern.slice(0, -2);
	}
	return undefined;
}

/**
 * Allow entries that would match every possible command: exactly `*`, the
 * empty string, or a wildcard pattern whose prefix is empty. Callers warn
 * about these and ignore them; under the pattern semantics above they are
 * degenerate and match nothing on their own. Broad deny/ask entries are
 * not special (deny-all is the user's explicit choice).
 */
export function findBroadAllowEntries(rules: AutomodeRules): string[] {
	return (rules.allow ?? []).filter((entry) => {
		const pattern = normalizeCommand(entry);
		if (pattern === "*" || pattern === "") {
			return true;
		}
		const prefix = wildcardPrefix(entry);
		return prefix !== undefined && prefix === "";
	});
}

/**
 * Evaluate user rules against a command: all deny entries first, then all
 * ask entries, then all allow entries; the first match wins. Returns the
 * verdict plus the matched rule for reason text, or undefined when no rule
 * matches. Matching happens on the normalized command.
 */
export function matchRules(
	command: string,
	rules: AutomodeRules,
): { verdict: AutomodeVerdict; rule: string } | undefined {
	const normalized = normalizeCommand(command);
	const phases: Array<{ verdict: AutomodeVerdict; entries: string[] }> = [
		{ verdict: "deny", entries: rules.deny ?? [] },
		{ verdict: "ask", entries: rules.ask ?? [] },
		{ verdict: "allow", entries: rules.allow ?? [] },
	];
	for (const phase of phases) {
		for (const entry of phase.entries) {
			if (matchesPattern(normalized, entry)) {
				return { verdict: phase.verdict, rule: entry };
			}
		}
	}
	return undefined;
}

const FLOOR_SUDO = "privilege escalation via sudo/su";
const FLOOR_RM_ROOT = "recursive forced rm on a root or home path";
const FLOOR_FORCE_PUSH = "git push --force";
const FLOOR_PERM_ROOT = "recursive chmod/chown on a root path";

/** Shell operators that end a word and start a new sub-command. */
const SEGMENT_SEPARATORS = new Set([";", "&", "|", "(", ")", "<", ">", "\n", "\r"]);

/**
 * Decode one backslash escape at `start` inside `$'...'` content per bash:
 * `\\` and `\'` unwrap, the C control escapes (`\a` `\b` `\e` `\E` `\f`
 * `\n` `\r` `\t` `\v`) become their control characters, `\xHH` (1-2 hex
 * digits) and `\nnn` (1-3 octal digits, masked to a byte) become that byte,
 * and `\cX` becomes control-X (the operand masked to its control bits).
 * Unknown escapes keep the backslash and the character. Returns the decoded
 * text and how many input characters it consumed.
 */
function decodeAnsiEscape(raw: string, start: number): { text: string; consumed: number } {
	const esc = raw[start + 1];
	if (esc === undefined) {
		return { text: "\\", consumed: 1 };
	}
	switch (esc) {
		case "\\":
			return { text: "\\", consumed: 2 };
		case "'":
			return { text: "'", consumed: 2 };
		case "a":
			return { text: "\x07", consumed: 2 };
		case "b":
			return { text: "\b", consumed: 2 };
		case "e":
		case "E":
			return { text: "\x1b", consumed: 2 };
		case "f":
			return { text: "\f", consumed: 2 };
		case "n":
			return { text: "\n", consumed: 2 };
		case "r":
			return { text: "\r", consumed: 2 };
		case "t":
			return { text: "\t", consumed: 2 };
		case "v":
			return { text: "\v", consumed: 2 };
		case "x": {
			const digits = /^[0-9A-Fa-f]{1,2}/.exec(raw.slice(start + 2))?.[0];
			if (digits !== undefined) {
				return {
					text: String.fromCharCode(Number.parseInt(digits, 16)),
					consumed: 2 + digits.length,
				};
			}
			return { text: "\\x", consumed: 2 };
		}
		case "c": {
			const ctrl = raw[start + 2];
			// The closing quote is never the operand: a bare `\c` stays literal.
			if (ctrl === undefined || ctrl === "'") {
				return { text: "\\c", consumed: 2 };
			}
			return { text: String.fromCharCode(ctrl.charCodeAt(0) & 0x1f), consumed: 3 };
		}
		default: {
			const digits = /^[0-7]{1,3}/.exec(raw.slice(start + 1))?.[0];
			if (digits !== undefined) {
				return {
					text: String.fromCharCode(Number.parseInt(digits, 8) & 0xff),
					consumed: 1 + digits.length,
				};
			}
			return { text: `\\${esc}`, consumed: 2 };
		}
	}
}

/**
 * After a decoded NUL truncated an ANSI-C part, skip the remainder of the
 * quoted content to just past its closing quote: backslash escapes still
 * protect a quote (`\'` does not close, `\\'` does), and a missing closing
 * quote runs to end of input.
 */
function skipAnsiRemainder(raw: string, start: number): number {
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
		} else if (ch === "\\") {
			escaped = true;
		} else if (ch === "'") {
			return i + 1;
		}
	}
	return raw.length;
}

/**
 * Split a raw command into shell segments (sub-commands separated by `;`,
 * `&`, `|`, `(`, `)`, `<`, `>`, newline, CR) and unfold every word per POSIX
 * quoting rules: adjacent quoted and unquoted segments concatenate
 * (`$HOME'/'` → `$HOME/`), backslash escapes unwrap (`\rm` → `rm`), and
 * quote characters never survive into the unfolded word. A `$` immediately
 * before an opening quote is ANSI-C (`$'...'`) or locale (`$"..."`) quoting:
 * the `$` never survives, and ANSI-C content has its backslash escapes
 * decoded per bash (`$'rm'` → `rm`, `$'\x2f'` → `/`, unknown escapes keep
 * the backslash) while locale content stays escape-literal. A decoded NUL
 * truncates the part like bash's C strings (`$'/\0etc'` → `/`); glued
 * tails outside the quotes still append. Separators
 * inside quotes are literal word content, not splits. Empty segments (from
 * `&&`,
 * `||`, a trailing `&`, parens) are kept: callers count segments to reject
 * anything that is not one plain command.
 */
function lexSegments(raw: string): string[][] {
	const segments: string[][] = [[]];
	let word = "";
	let started = false;
	let inSingle = false;
	let inDouble = false;
	let ansiDecode = false;
	const endWord = () => {
		if (started) {
			segments[segments.length - 1]?.push(word);
			word = "";
			started = false;
		}
	};
	const endSegment = () => {
		endWord();
		segments.push([]);
	};
	let i = 0;
	while (i < raw.length) {
		const ch = raw[i] ?? "";
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				ansiDecode = false;
				i += 1;
				continue;
			}
			if (ansiDecode && ch === "\\") {
				const { text, consumed } = decodeAnsiEscape(raw, i);
				if (text.includes("\0")) {
					// C-string semantics: a decoded NUL ends the decoded content.
					// Drop the rest of the quoted content and resume lexing after
					// the closing quote; glued tails still append, like bash.
					i = skipAnsiRemainder(raw, i + consumed);
					inSingle = false;
					ansiDecode = false;
					continue;
				}
				word += text;
				i += consumed;
				continue;
			}
			word += ch;
			i += 1;
			continue;
		}
		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				i += 1;
				continue;
			}
			if (ch === "\\") {
				const next = raw[i + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					word += next;
					i += 2;
					continue;
				}
				if (next === "\n") {
					i += 2;
					continue;
				}
				word += ch;
				i += 1;
				continue;
			}
			word += ch;
			i += 1;
			continue;
		}
		if (ch === "$") {
			const next = raw[i + 1];
			if (next === "'") {
				// ANSI-C ($'...') quoting: bash drops the $ and decodes backslash
				// escapes in the content, so this quote opens in decode mode.
				inSingle = true;
				ansiDecode = true;
				started = true;
				i += 2;
				continue;
			}
			if (next === '"') {
				// Locale ($"...") quoting: the $ never survives into the word and
				// the content stays escape-literal. Let the quote open normally
				// on the next iteration.
				i += 1;
				continue;
			}
		}
		if (ch === "'") {
			inSingle = true;
			started = true;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			started = true;
			i += 1;
			continue;
		}
		if (ch === "\\") {
			const next = raw[i + 1];
			if (next === undefined) {
				word += ch;
				started = true;
				i += 1;
				continue;
			}
			if (next === "\n") {
				i += 2;
				continue;
			}
			word += next;
			started = true;
			i += 2;
			continue;
		}
		if (SEGMENT_SEPARATORS.has(ch)) {
			endSegment();
			i += 1;
			continue;
		}
		if (/\s/.test(ch)) {
			endWord();
			i += 1;
			continue;
		}
		word += ch;
		started = true;
		i += 1;
	}
	endWord();
	return segments;
}

/** The command a word spells: path components stripped (`/bin/rm` → `rm`). */
function verbOf(word: string): string {
	return word.slice(word.lastIndexOf("/") + 1);
}

/** Strip one layer of matching surrounding single or double quotes. */
function stripSurroundingQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		if ((first === "'" || first === '"') && token.endsWith(first)) {
			return token.slice(1, -1);
		}
	}
	return token;
}

/** Lexically resolve `.`/`..` segments and duplicate slashes under `prefix`. */
function resolveSegments(prefix: "/" | "~", path: string): string {
	const stack: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") {
			continue;
		}
		if (segment === "..") {
			stack.pop();
			continue;
		}
		stack.push(segment);
	}
	const joined = stack.join("/");
	if (joined === "") {
		return prefix;
	}
	return prefix === "/" ? `/${joined}` : `${prefix}/${joined}`;
}

/**
 * Canonicalize an unfolded path operand for floor comparison: any literal
 * quote layer stripped, `$HOME`/`${HOME...}` and `~+`/`~-` mapped to the
 * home marker `~` (they expand to the home directory or a possibly-root
 * cwd), then `.`/`..` segments resolved and duplicate slashes collapsed
 * lexically (POSIX path resolution; `/etc` never fuses to `/`, but
 * `/etc/..` resolves to `/`). `~user` forms stay opaque: another user's
 * home is not the home marker. Root and home respellings (`//`, `'/'`,
 * `~/`, `"$HOME"`, `${HOME%/}`, `/./`, `/../`, `~/.`) all reduce to the
 * same canonical form before comparison.
 */
function canonicalTarget(token: string): string {
	let target = stripSurroundingQuotes(token);
	target = target.replace(/^\$\{HOME[^}]*\}/, "~").replace(/^\$HOME/, "~");
	target = target.replace(/^~[+-](?=\/|$)/, "~");
	if (target === "~") {
		return "~";
	}
	if (target.startsWith("~/")) {
		return resolveSegments("~", target.slice(1));
	}
	if (target.startsWith("/")) {
		return resolveSegments("/", target);
	}
	return target;
}

/** Canonical `/` or `~` themselves, or a glob directly under either. */
function isRootOrHomeTarget(token: string): boolean {
	const target = canonicalTarget(token);
	return target === "/" || target === "~" || target === "/*" || target === "~/*";
}

function forcedRecursiveRmOnRoot(tokens: string[]): boolean {
	if (verbOf(tokens[0] ?? "") !== "rm") {
		return false;
	}
	let recursive = false;
	let force = false;
	let operandsOnly = false;
	const targets: string[] = [];
	for (const token of tokens.slice(1)) {
		if (operandsOnly) {
			targets.push(token);
		} else if (token === "--") {
			operandsOnly = true;
		} else if (token === "--recursive") {
			recursive = true;
		} else if (token === "--force") {
			force = true;
		} else if (token.startsWith("--")) {
			// Unknown long flag: irrelevant to classification.
		} else if (token.startsWith("-") && token.length > 1) {
			// Short-flag cluster, e.g. -rf / -fR.
			const flags = token.slice(1);
			if (flags.includes("r") || flags.includes("R")) {
				recursive = true;
			}
			if (flags.includes("f")) {
				force = true;
			}
		} else {
			targets.push(token);
		}
	}
	return recursive && force && targets.some(isRootOrHomeTarget);
}

/** Git global options that consume a separate value argument. */
const GIT_GLOBALS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
]);

/**
 * `git push --force`/`-f`, tolerating ANY git global options between `git`
 * and `push` (`--no-pager`, `--git-dir=.git`, `-C repo`, ...). Value-taking
 * globals consume their separated argument, so a `push` eaten as a global's
 * value (a command git itself rejects) never counts. Attached values
 * (`--git-dir=x`) and `--` end the globals. `--force-with-lease` and any
 * other flag spelling never matches; only exact `--force`/`-f` tokens do.
 */
function isForcePush(tokens: string[]): boolean {
	if (verbOf(tokens[0] ?? "") !== "git") {
		return false;
	}
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i] ?? "";
		if (token === "--") {
			i += 1;
			break;
		}
		if (!token.startsWith("-")) {
			break;
		}
		if (token.includes("=") || !GIT_GLOBALS_WITH_VALUE.has(token)) {
			i += 1;
			continue;
		}
		i += 2;
	}
	if ((tokens[i] ?? "") !== "push") {
		return false;
	}
	return tokens.slice(i + 1).some((token) => token === "--force" || token === "-f");
}

function recursivePermOnRoot(tokens: string[]): boolean {
	const verb = verbOf(tokens[0] ?? "");
	if (verb !== "chmod" && verb !== "chown") {
		return false;
	}
	let recursive = false;
	let operandsOnly = false;
	const targets: string[] = [];
	for (const token of tokens.slice(1)) {
		if (operandsOnly) {
			targets.push(token);
		} else if (token === "--") {
			operandsOnly = true;
		} else if (token === "--recursive" || token === "-R") {
			recursive = true;
		} else if (token.startsWith("--")) {
			// Unknown long flag: irrelevant to classification.
		} else if (token.startsWith("-") && token.length > 1) {
			if (token.slice(1).includes("R")) {
				recursive = true;
			}
		} else {
			targets.push(token);
		}
	}
	return recursive && targets.some(isRootOrHomeTarget);
}

/**
 * Hardcoded critical-operation floor. The command is split
 * on shell separators into segments, and every segment word is scanned as
 * a potential verb: the basename of the unfolded word, so quoted (`'rm'`),
 * escaped (`\rm`), and path-spelled (`/bin/rm`) verbs all resolve. Floors:
 * `sudo`/`su` as any segment word in any spelling; recursive forced `rm`
 * whose lexically canonicalized target is `/` or the home marker
 * (quote/`$HOME`/tilde/dot-segment/duplicate-slash respellings included;
 * `rm -rf /etc`, `./build`, and `~user` targets do not floor); `git push
 * --force`/`-f` after any git global options (`--force-with-lease` does
 * not floor); recursive `chmod`/`chown` with `/` or home as target root.
 * Command substitution does not floor: the decision model judges the full
 * command text (substitution bodies included) exactly as it judges pipes
 * and `;` chains, and the read-only fast path already refuses substitutions.
 * Scanning past wrappers (`nice rm
 * -rf /`, `env`) also floors `echo rm -rf /` style lines by design:
 * over-matching is safe, under-matching is the bug class. Returns the
 * triggering class label, or undefined when the command is not in any
 * critical class.
 *
 * These classes judge rather than ask: the caller routes a floor hit to
 * the decision model with the class riding into the prompt as a boundary,
 * skips every allow shortcut (allow rules, fast path, cache), and falls
 * back to asking only when the judge cannot run. Allow rules therefore
 * never bypass the floor; callers must check criticalAskFloor BEFORE
 * trusting a rule allow.
 */
export function criticalAskFloor(command: string): string | undefined {
	for (const segment of lexSegments(command)) {
		for (let i = 0; i < segment.length; i++) {
			const verb = verbOf(segment[i] ?? "");
			const rest = segment.slice(i);
			if (verb === "sudo" || verb === "su") {
				return FLOOR_SUDO;
			}
			if (verb === "rm" && forcedRecursiveRmOnRoot(rest)) {
				return FLOOR_RM_ROOT;
			}
			if (verb === "git" && isForcePush(rest)) {
				return FLOOR_FORCE_PUSH;
			}
			if ((verb === "chmod" || verb === "chown") && recursivePermOnRoot(rest)) {
				return FLOOR_PERM_ROOT;
			}
		}
	}
	return undefined;
}

const SIMPLE_READ_ONLY_PREFIXES = new Set([
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"rg",
	"find",
	"file",
	"which",
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show"]);

/** `git branch` fast-paths only with no operands or read-only flags. */
const GIT_BRANCH_READ_ONLY_FLAGS = new Set([
	"-a",
	"-l",
	"-v",
	"-vv",
	"-r",
	"-av",
	"-va",
	"--all",
	"--list",
	"--verbose",
	"--remotes",
	"--show-current",
]);

/** A bare `<program> --version` / `-V` / `-v` probe, nothing else. */
const VERSION_PROBE_FLAGS = new Set(["--version", "-V", "-v"]);

/** `find` actions that mutate or execute code keep the command out. */
const FIND_MUTATING_FLAGS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

/**
 * True iff the command is a safe read-only probe: a single shell segment —
 * no separators (even quoted ones), no raw control characters, no command
 * substitution, no shell metacharacters — whose first verb, taken from the
 * unfolded word's basename (`'ls'`, `\ls`, `/bin/ls` all count), is one of
 * the plain read-only prefixes (`ls`, `cat`, `grep`, ...), a read-only git
 * subcommand (`git status|diff|log|show`, `git branch` without mutating
 * arguments), `find` without mutating actions (mutating flags compared
 * against unfolded tokens, so `\-delete` and `-ex'ec'` are still caught),
 * or a bare version probe (`node --version`, `rustc -V`). sudo/su are
 * never read-only verbs in any spelling. Chained commands, redirections,
 * and code execution are never fast-pathed.
 */
export function isReadOnlyFastPath(command: string): boolean {
	if (/[\x00-\x1f\x7f]/.test(command)) {
		return false;
	}
	if (command.includes("$(") || command.includes("`")) {
		return false;
	}
	if (/[;|>&]/.test(command)) {
		return false;
	}
	const segments = lexSegments(command);
	if (segments.length !== 1) {
		return false;
	}
	const tokens = segments[0] ?? [];
	const verb = verbOf(tokens[0] ?? "");
	if (
		tokens.length === 2 &&
		verb !== "sudo" &&
		verb !== "su" &&
		VERSION_PROBE_FLAGS.has(tokens[1] ?? "")
	) {
		return true;
	}
	if (verb === "git") {
		const sub = tokens[1] ?? "";
		if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
			return true;
		}
		if (sub === "branch") {
			return tokens.slice(2).every((token) => GIT_BRANCH_READ_ONLY_FLAGS.has(token));
		}
		return false;
	}
	if (verb === "find") {
		return !tokens.slice(1).some((token) => FIND_MUTATING_FLAGS.has(token));
	}
	return SIMPLE_READ_ONLY_PREFIXES.has(verb);
}
