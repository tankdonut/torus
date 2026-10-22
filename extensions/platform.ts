/**
 * Per-extension platform support declarations and the load-time gate.
 *
 * Every torus extension exports a `PLATFORM_SUPPORT` descriptor and calls
 * `gateExtension(name, support)` as the first statement of its default
 * export. When the running platform is not in `platforms`, the extension
 * registers nothing, the decision is recorded on the `torus.platform.v1`
 * globalThis slot (read by /doctor), and a one-time stderr notice names the
 * skip. `deps` are tracked for diagnostics only; they never gate loading.
 *
 * `TORUS_PLATFORM` overrides detection for tests and simulation; invalid
 * values warn once and fall back to `process.platform`. Unrecognized
 * `process.platform` values (builds outside linux/darwin/win32) warn once
 * and pass through, so extensions that list explicit platforms skip there
 * too — an honest fail-safe rather than a silent linux assumption.
 */

export type Platform = "linux" | "darwin" | "win32";

export type ExtensionDep = { name: string; required: boolean; note?: string };

export type PlatformSupport = {
	platforms: Platform[];
	deps?: ExtensionDep[];
	note?: string;
};

export type GateDecision = {
	name: string;
	support: PlatformSupport;
	loaded: boolean;
	platform: Platform;
};

type PlatformRegistry = {
	decisions: GateDecision[];
	noticed: Set<string>;
	warned: Set<string>;
};

const KNOWN_PLATFORMS: readonly Platform[] = ["linux", "darwin", "win32"];
const known = new Set<string>(KNOWN_PLATFORMS);
const SLOT = Symbol.for("torus.platform.v1");

function registry(): PlatformRegistry {
	const store = globalThis as Record<symbol, PlatformRegistry | undefined>;
	store[SLOT] ??= { decisions: [], noticed: new Set(), warned: new Set() };
	return store[SLOT];
}

function warnOnce(key: string, message: string): void {
	const reg = registry();
	if (reg.warned.has(key)) return;
	reg.warned.add(key);
	process.stderr.write(`[torus: platform] ${message}\n`);
}

/** The effective platform: `TORUS_PLATFORM` override when valid, else `process.platform`. */
export function currentPlatform(): Platform {
	const override = process.env["TORUS_PLATFORM"];
	if (override !== undefined && override !== "") {
		if (known.has(override)) return override as Platform;
		warnOnce(
			`override:${override}`,
			`TORUS_PLATFORM="${override}" is not one of ${KNOWN_PLATFORMS.join(", ")} — using ${process.platform}`,
		);
	} else if (!known.has(process.platform)) {
		warnOnce(
			`host:${process.platform}`,
			`unrecognized platform "${process.platform}" — extensions listing explicit platforms will skip`,
		);
	}
	return process.platform as Platform;
}

/**
 * Load-time gate. Returns true (and records the decision) when the extension
 * should register; false after recording the skip and emitting the one-time
 * stderr notice. Never throws: a failing gate must degrade to a skipped
 * extension, never an aborted boot.
 */
export function gateExtension(name: string, support: PlatformSupport): boolean {
	const platform = currentPlatform();
	const loaded = support.platforms.includes(platform);
	const reg = registry();
	reg.decisions.push({ name, support, loaded, platform });
	if (loaded) return true;
	if (!reg.noticed.has(name)) {
		reg.noticed.add(name);
		const reason = support.note ? ` (${support.note})` : "";
		process.stderr.write(`[torus: platform] ${name} skipped on ${platform}${reason}\n`);
	}
	return false;
}

/** Decisions recorded so far this process, in gate-call order (read by /doctor). */
export function platformDecisions(): readonly GateDecision[] {
	return registry().decisions;
}

/** Reset the shared registry so tests start from a clean slot. */
export function resetPlatformRegistryForTests(): void {
	const store = globalThis as Record<symbol, PlatformRegistry | undefined>;
	store[SLOT] = { decisions: [], noticed: new Set(), warned: new Set() };
}
