/**
 * Launcher-owned --permission-mode flag handling.
 *
 * Pure module (no side effects) so tests can import it without executing the
 * launcher. torus.mjs consumes the flag from the engine-passthrough argv,
 * exports the chosen mode as TORUS_PERMISSION_MODE for the spawned engine
 * (the flag overrides any pre-set env value), and forwards the remaining
 * tokens unchanged.
 *
 * Semantics:
 * - Both spellings are accepted anywhere in argv: `--permission-mode=VALUE`
 *   and two-token `--permission-mode VALUE`.
 * - VALUE must be exactly `auto`, `default`, or `bypass` (lowercase); anything
 *   else is an error naming the bad value and the three valid ones.
 * - Every occurrence (and a two-token form's VALUE token) is stripped from the
 *   returned argv; other tokens keep their order.
 * - Repeated flags: the last occurrence's mode wins.
 * - An invalid occurrence anywhere is an error even if other occurrences are
 *   valid; the first error is reported and `mode` is undefined.
 * - A `--permission-mode` as the final token (no VALUE to consume) is an
 *   error, never silently ignored.
 * - When no flag is present the input argv is returned untouched (same
 *   reference) and no mode is set: passthrough is identity.
 */

const FLAG = "--permission-mode";
const EQUALS_FLAG = "--permission-mode=";
const VALID_MODES = new Set(["auto", "default", "bypass"]);
const VALID_LIST = '"auto", "default", or "bypass"';

/**
 * Extract the --permission-mode flag from an argv array.
 *
 * @param {string[]} argv Launcher argv (process.argv minus the first two).
 * @returns {{ argv: string[], mode?: "auto" | "default" | "bypass", error?: string }}
 *   Stripped argv plus the resolved mode, or an error message (mode undefined
 *   on error; argv still has every flag occurrence stripped).
 */
export function extractPermissionMode(argv) {
	const stripped = [];
	let mode;
	let error;
	let sawFlag = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === FLAG) {
			sawFlag = true;
			const value = argv[i + 1];
			if (value === undefined) {
				error ??= `missing value; expected ${VALID_LIST}`;
			} else if (!VALID_MODES.has(value)) {
				error ??= `unknown value "${value}"; expected ${VALID_LIST}`;
			} else {
				mode = value;
			}
			i++; // skip the VALUE token
			continue;
		}
		if (token.startsWith(EQUALS_FLAG)) {
			sawFlag = true;
			const value = token.slice(EQUALS_FLAG.length);
			if (!VALID_MODES.has(value)) {
				error ??= `unknown value "${value}"; expected ${VALID_LIST}`;
			} else {
				mode = value;
			}
			continue;
		}
		stripped.push(token);
	}
	if (error !== undefined) return { argv: stripped, error };
	if (!sawFlag) return { argv };
	return { argv: stripped, mode };
}
