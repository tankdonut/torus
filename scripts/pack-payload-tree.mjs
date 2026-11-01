#!/usr/bin/env node
/**
 * Packs the payload dependency tree (pinned engine included) into one
 * deterministic tar.gz: generates the payload-native lock, bakes the payload
 * into a staging dir, runs `npm ci --omit=dev` there (network required —
 * this is build-time by design), verifies the engine landed, then archives
 * staging/node_modules with zeroed metadata and sorted entries so identical
 * input trees give byte-identical archives.
 *
 * Usage: node scripts/pack-payload-tree.mjs [outPath]
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { generatePayloadLock, payloadLockPath } from "./generate-payload-lock.mjs";
import { writeTar } from "./lib/tar.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Env var every payload-tree consumer honors: explicit path for the packed tar. */
export const PAYLOAD_TREE_ENV = "TORUS_PAYLOAD_TREE_OUT";

/** Path the packed payload tree is written to and read from. */
export function payloadTreePath() {
	const override = process.env[PAYLOAD_TREE_ENV];
	return override ? path.resolve(override) : path.join(root, "dist", "payload-tree.tar.gz");
}

/** Directory entries (files, dirs, symlinks) under `dir`, paths relative to it. */
function collectEntries(dir, rel, out) {
	for (const name of readdirSync(path.join(dir, rel)).sort()) {
		const relPath = rel ? `${rel}/${name}` : name;
		const abs = path.join(dir, relPath);
		const stat = lstatSync(abs);
		if (stat.isDirectory()) {
			out.push({ path: relPath, typeflag: "5", mode: stat.mode & 0o7777 });
			collectEntries(dir, relPath, out);
		} else if (stat.isSymbolicLink()) {
			out.push({ path: relPath, typeflag: "2", mode: 0o777, linkpath: readlinkSync(abs) });
		} else if (stat.isFile()) {
			out.push({
				path: relPath,
				typeflag: "0",
				mode: stat.mode & 0o7777,
				bytes: readFileSync(abs),
			});
		} else {
			throw new Error(`cannot pack non-file entry: ${abs}`);
		}
	}
	return out;
}

/**
 * Archives a directory tree into a gzip (level 6) tar.gz buffer. Determinism:
 * writeTar sorts entries and zeroes all metadata, so the same tree yields the
 * same bytes on every run.
 */
export function packDir(dir) {
	const tar = writeTar(collectEntries(dir, "", []));
	return { tarGz: gzipSync(tar, { level: 6 }) };
}

function fail(message) {
	process.stderr.write(`pack-payload-tree: ${message}\n`);
	process.exit(1);
}

function run(cmd, args, options) {
	const run = spawnSync(cmd, args, { encoding: "utf8", ...options });
	if (run.status !== 0) {
		const detail = (run.stderr || run.stdout || "").trim();
		fail(`${cmd} ${args.join(" ")} failed (exit ${run.status})\n${detail}`);
	}
	return run;
}

function packageCount(lockPath) {
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	return Object.keys(lock.packages ?? {}).filter((key) => key !== "").length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = process.argv[2] ? path.resolve(process.argv[2]) : payloadTreePath();
	const staging = path.join(root, "dist", "payload-tree-stage");

	const lock = generatePayloadLock({ out: payloadLockPath() });
	if (!lock.ok) {
		fail(lock.error);
	}

	rmSync(staging, { recursive: true, force: true });
	run(process.execPath, [path.join(root, "scripts", "bake-payload.mjs"), staging]);
	run("npm", ["ci", "--no-fund", "--no-audit", "--omit=dev", "--legacy-peer-deps"], {
		cwd: staging,
	});

	const engineCli = path.join(
		staging,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"cli.js",
	);
	if (!existsSync(engineCli)) {
		fail(`npm ci did not install the engine (${path.relative(root, engineCli)} is missing)`);
	}

	const { tarGz } = packDir(path.join(staging, "node_modules"));
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, tarGz);
	const mib = (tarGz.length / (1024 * 1024)).toFixed(1);
	process.stderr.write(
		`payload tree packed to ${out}: ${tarGz.length} bytes (${mib} MiB), ${packageCount(
			payloadLockPath(),
		)} packages\n`,
	);
}
