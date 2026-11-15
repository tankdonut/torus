/**
 * Launcher-owned --incognito flag handling.
 *
 * Pure module (no side effects) so tests can import it without executing the
 * launcher. torus.mjs consumes the flag from the engine-passthrough argv and
 * exports TORUS_INCOGNITO=1 for the spawned engine (the flag overrides any
 * pre-set env value), then forwards the remaining tokens unchanged.
 *
 * Semantics mirror permission-mode.mjs: both spellings accepted anywhere
 * (`--incognito` and `--incognito=1`), repeated flags are harmless, and no
 * value token is consumed — incognito carries no arguments.
 */

const FLAG = "--incognito";
const EQUALS_FLAG = "--incognito=";

export function extractIncognito(argv) {
	const stripped = [];
	let sawFlag = false;
	for (const token of argv) {
		if (token === FLAG) {
			sawFlag = true;
			continue;
		}
		if (token.startsWith(EQUALS_FLAG)) {
			sawFlag = true;
			continue;
		}
		stripped.push(token);
	}
	return { argv: stripped, sawFlag };
}
