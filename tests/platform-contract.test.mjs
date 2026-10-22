import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const ambientPlatform = process.env["TORUS_PLATFORM"];

const { gateExtension, resetPlatformRegistryForTests } = await import("../extensions/platform.ts");

const KNOWN_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const SKIPS_BY_PLATFORM = {
	linux: [],
	darwin: ["interactive", "notify", "sandbox"],
	win32: ["interactive", "monitor", "notify", "sandbox"],
};

/**
 * Every torus-owned pi.extensions entry plus the serve launcher surface
 * (not manifest-loaded). External node_modules extensions are tracked in
 * docs only and are deliberately absent here.
 */
function torusExtensionModules() {
	const entries = pkg.pi.extensions
		.filter((entry) => !entry.startsWith("./node_modules/"))
		.map((entry) => ({
			name: path.basename(entry),
			spec: `../${entry.replace(/^\.\//, "")}/index.ts`,
		}));
	entries.push({ name: "serve", spec: "../extensions/serve/index.ts" });
	return entries;
}

async function loadAll() {
	const modules = [];
	for (const entry of torusExtensionModules()) {
		modules.push({ name: entry.name, module: await import(entry.spec) });
	}
	return modules;
}

function assertValidSupport(name, support) {
	assert.ok(support, `${name} must export PLATFORM_SUPPORT`);
	assert.ok(Array.isArray(support.platforms), `${name}: platforms must be an array`);
	assert.ok(support.platforms.length > 0, `${name}: platforms must not be empty`);
	for (const platform of support.platforms) {
		assert.ok(KNOWN_PLATFORMS.has(platform), `${name}: unknown platform "${platform}"`);
	}
	if (support.deps !== undefined) {
		assert.ok(Array.isArray(support.deps), `${name}: deps must be an array`);
		for (const dep of support.deps) {
			assert.equal(typeof dep.name, "string", `${name}: dep.name must be a string`);
			assert.equal(typeof dep.required, "boolean", `${name}: dep.required must be boolean`);
			if (dep.note !== undefined) {
				assert.equal(typeof dep.note, "string", `${name}: dep.note must be a string`);
			}
		}
	}
}

test("every torus extension module declares valid PLATFORM_SUPPORT", async () => {
	const modules = await loadAll();
	assert.ok(modules.length >= 30, `extension walk looks broken (found ${modules.length})`);
	for (const { name, module } of modules) {
		assertValidSupport(name, module.PLATFORM_SUPPORT);
	}
});

test("on linux every torus extension gate decision is loaded (registration-set guard)", async () => {
	const saved = process.env["TORUS_PLATFORM"];
	process.env["TORUS_PLATFORM"] = "linux";
	try {
		const modules = await loadAll();
		resetPlatformRegistryForTests();
		for (const { name, module } of modules) {
			assert.equal(
				gateExtension(name, module.PLATFORM_SUPPORT),
				true,
				`${name} must load on linux — the linux registration set must not regress`,
			);
		}
	} finally {
		if (saved === undefined) delete process.env["TORUS_PLATFORM"];
		else process.env["TORUS_PLATFORM"] = saved;
	}
});

test("ambient TORUS_PLATFORM override yields exactly the expected skip set", async () => {
	const platform =
		ambientPlatform === undefined || ambientPlatform === "" ? "linux" : ambientPlatform;
	const expectedSkips = SKIPS_BY_PLATFORM[platform];
	assert.ok(expectedSkips, `no expected skip set for platform "${platform}"`);

	const saved = process.env["TORUS_PLATFORM"];
	if (ambientPlatform !== undefined) process.env["TORUS_PLATFORM"] = ambientPlatform;
	try {
		const modules = await loadAll();
		resetPlatformRegistryForTests();
		const skipped = [];
		for (const { name, module } of modules) {
			if (!gateExtension(name, module.PLATFORM_SUPPORT)) skipped.push(name);
		}
		assert.deepEqual(
			skipped.sort(),
			[...expectedSkips].sort(),
			`skip set on ${platform} must match the declared platform support`,
		);
	} finally {
		if (saved === undefined) delete process.env["TORUS_PLATFORM"];
		else process.env["TORUS_PLATFORM"] = saved;
	}
});
