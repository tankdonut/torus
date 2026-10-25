#!/usr/bin/env node
// torus local-ops microbench — per-turn filesystem cost of the extension
// layer, measured directly against the real modules. No engine spawns, no
// network, no model calls: every axis times a synchronous read/scan path the
// harness performs during a turn, so later optimization deltas stay exact.
//
// Run from the repo root:
//   node --experimental-strip-types --import ./tests/resolve-ts-hook.mjs \
//     scripts/bench/local-ops.mjs
//
// Fixtures are generated deterministically (seeded PRNG) under a fresh
// os.tmpdir subdir and removed at exit. Several modules capture state paths
// at import time (fsutil's ensureStateDirEnv, the memory store root, the
// transcript session roots), so every axis points TORUS_HOME / the
// session-roots env at its own fixture BEFORE importing the module under
// test; a module needed twice under different homes is re-imported with a
// cache-busting query string. Nothing here touches real user state.

import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// Env control must precede every extension import. TORUS_ENGINE_CHILD and
// TORUS_STATE_DIR pin state paths to the dispatching project when inherited;
// the pi session dirs would leak the real home into the transcript roots.
// Each axis sets TORUS_HOME (and the transcript axis the session root) before
// its dynamic import, so captured-at-load paths point at fixtures only.
for (const name of [
	"TORUS_ENGINE_CHILD",
	"TORUS_STATE_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_CODING_AGENT_DIR",
]) {
	delete process.env[name];
}

let tmpBase = null;
process.on("exit", () => {
	if (tmpBase !== null) rmSync(tmpBase, { recursive: true, force: true });
});

function fail(message, error) {
	console.error(`local-ops: ${message}`);
	if (error !== undefined) console.error(error);
	process.exit(1);
}

/** Deterministic PRNG so every run generates byte-identical fixtures. */
function mulberry32(seed) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median-of-N ms for `fn`, after `warmup` discarded calls. */
function bench(fn, iterations, warmup = 3) {
	for (let i = 0; i < warmup; i++) fn();
	const samples = new Array(iterations);
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		fn();
		samples[i] = performance.now() - start;
	}
	return median(samples);
}

function fixtureDir(name) {
	const dir = path.join(tmpBase, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const WORDS = [
	"alpha",
	"bravo",
	"charlie",
	"delta",
	"echo",
	"foxtrot",
	"golf",
	"hotel",
	"india",
	"juliet",
	"kilo",
	"lima",
	"mike",
	"november",
	"oscar",
	"papa",
];

function pick(rng) {
	return WORDS[Math.floor(rng() * WORDS.length)];
}

function sentence(rng) {
	const a = pick(rng);
	const b = pick(rng);
	const c = pick(rng);
	return `The ${a} stage reads the ${b} manifest before the ${c} pipeline settles, so the next turn sees a consistent tree.`;
}

/** Code-shaped fixture: `lineCount` ASCII lines averaging `targetBytes` total. */
function sourceFixture(lineCount, targetBytes, rng) {
	const width = Math.max(32, Math.floor(targetBytes / lineCount) - 1);
	const lines = [];
	for (let i = 0; i < lineCount; i++) {
		const head = `\tconst ${pick(rng)}_${i} = resolve("${pick(rng)}", ${Math.floor(rng() * 1000)});`;
		let line = head;
		while (line.length < width) line += ` ${pick(rng)}`;
		lines.push(line.slice(0, width));
	}
	return lines;
}

function uuidLike(i) {
	return `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

const rows = [];

async function main() {
	tmpBase = mkdtempSync(path.join(tmpdir(), "torus-local-ops-"));
	const rng = mulberry32(0x10ca1);

	// --- config-knob -------------------------------------------------------
	// loadConfigFile() (user config.json read) and one knobBoolean resolution
	// (user tier miss -> project tier read) against a fixture home holding a
	// real config.json, so both tiers parse actual bytes.
	{
		const home = fixtureDir("config-home");
		process.env.TORUS_HOME = home;
		delete process.env.X;
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify(
				{ ui: { banner: true }, y: { unrelated: true }, guards: { enabled: true } },
				null,
				2,
			),
			"utf8",
		);
		const loader = await import("../../extensions/config/loader.ts");
		const knobs = await import("../../extensions/config/knobs.ts");
		const loadConfigFileMs = bench(() => loader.loadConfigFile(), 1000, 50);
		const knobBooleanMs = bench(() => knobs.knobBoolean("X", "y", "z", false), 1000, 50);
		if (!Number.isFinite(loadConfigFileMs) || !Number.isFinite(knobBooleanMs)) {
			fail("config-knob: non-finite median");
		}
		rows.push({
			axis: "config-knob",
			medianMs: knobBooleanMs,
			iterations: 1000,
			detail: { loadConfigFileMs, knobBooleanMs },
			note: `loadConfigFile ${fmtMs(loadConfigFileMs)} · knobBoolean ${fmtMs(knobBooleanMs)} per call`,
		});
	}

	// --- write-guard-333k / write-guard-1400k ------------------------------
	// One combined per-call cost of the write-guard pair on a near-identical
	// full rewrite: writeBlockReason (symlink scan + disk read + line
	// multiset similarity) plus addedLinesForWrite (added-line diff) from the
	// comment checker, at two fixture sizes.
	{
		const guards = await import("../../extensions/guards/index.ts");
		const checker = await import("../../extensions/comment-checker/index.ts");
		for (const spec of [
			{ axis: "write-guard-333k", lineCount: 5000, targetBytes: 333 * 1024, label: "333 KB" },
			{ axis: "write-guard-1400k", lineCount: 20_000, targetBytes: 1_400_000, label: "1.4 MB" },
		]) {
			const dir = fixtureDir(spec.axis);
			const lines = sourceFixture(spec.lineCount, spec.targetBytes, rng);
			const disk = lines.join("\n");
			const target = path.join(dir, "module.ts");
			writeFileSync(target, disk, "utf8");
			const mid = Math.floor(lines.length / 2);
			lines[mid] = "\tconst nearIdenticalRewriteProbe = 1; // one line changed";
			const content = lines.join("\n");
			const medianMs = bench(() => {
				guards.writeBlockReason(target, content);
				checker.addedLinesForWrite(content, disk);
			}, 50);
			if (!Number.isFinite(medianMs)) fail(`${spec.axis}: non-finite median`);
			rows.push({
				axis: spec.axis,
				medianMs,
				iterations: 50,
				note: `writeBlockReason + addedLinesForWrite, ${spec.lineCount.toLocaleString("en-US")} lines / ${spec.label}`,
			});
		}
	}

	// --- work-context-idle --------------------------------------------------
	// workContextBlock for a session that owns no work: the per-turn path
	// still scans the project work dir, its legacy twin, and every sibling
	// project's work dir under the state root before concluding there is
	// nothing active. Measured against an empty fixture home.
	{
		const home = fixtureDir("work-idle-home");
		process.env.TORUS_HOME = home;
		const work = await import("../../extensions/work/index.ts");
		const medianMs = bench(() => work.workContextBlock("nonexistent-session-id"), 200);
		if (!Number.isFinite(medianMs)) fail("work-context-idle: non-finite median");
		rows.push({
			axis: "work-context-idle",
			medianMs,
			iterations: 200,
			note: 'workContextBlock("nonexistent-session-id"), empty state tree',
		});
	}

	// --- memory-list-50 / memory-list-200 -----------------------------------
	// Full memory store read per turn via memoryContextBlock (the exported
	// surface; the internal listEntries readdir+read+parse of every entry is
	// the cost): profile read, then every entry file parsed. The store root is
	// captured from TORUS_HOME at module load, so each store size imports its
	// own module instance with a cache-busting query string.
	for (const count of [50, 200]) {
		const home = fixtureDir(`memory-home-${count}`);
		process.env.TORUS_HOME = home;
		const entriesDir = path.join(home, "memory", "entries");
		mkdirSync(entriesDir, { recursive: true });
		for (let i = 0; i < count; i++) {
			const frontmatter = [
				"---",
				`topic: fixture entry ${i}`,
				`tags: bench, fixture, ${pick(rng)}`,
				"project: global",
				"created: 2026-10-01T00:00:00.000Z",
				"---",
				"",
			].join("\n");
			let body = "";
			while (frontmatter.length + body.length < 2048) body += `${sentence(rng)}\n`;
			const name = `2026-09-${String((i % 28) + 1).padStart(2, "0")}-fixture-entry-${String(i).padStart(3, "0")}.md`;
			writeFileSync(
				path.join(entriesDir, name),
				`${(frontmatter + body).slice(0, 2048)}\n`,
				"utf8",
			);
		}
		const memory = await import(
			`${pathToFileURL(path.join(ROOT, "extensions/memory/index.ts")).href}?store=${count}`
		);
		if (typeof memory.memoryContextBlock !== "function") {
			fail(`memory-list-${count}: memoryContextBlock not exported`);
		}
		const medianMs = bench(() => memory.memoryContextBlock(home, "", ""), 30);
		if (!Number.isFinite(medianMs)) fail(`memory-list-${count}: non-finite median`);
		rows.push({
			axis: `memory-list-${count}`,
			medianMs,
			iterations: 30,
			note: `memoryContextBlock full store read, ${count} entries × 2 KB`,
		});
	}

	// --- sessions-search-nohit ----------------------------------------------
	// searchSessions with a needle that matches nothing: every transcript in
	// the tree is read in full before being discarded. Fixture tree: 30
	// project dirs × 3 transcripts, one 8 MB, the rest ~200 KB.
	{
		const root = fixtureDir("sessions-tree");
		for (let d = 0; d < 30; d++) {
			const dir = path.join(root, `proj-${String(d).padStart(2, "0")}`);
			mkdirSync(dir, { recursive: true });
			for (let f = 0; f < 3; f++) {
				const big = d === 15 && f === 0;
				const target = big ? 8 * 1024 * 1024 : 200 * 1024;
				const file = path.join(
					dir,
					`2026-10-01T09-${String(d).padStart(2, "0")}-00_${uuidLike(d * 3 + f)}.jsonl`,
				);
				let chunk = "";
				while (chunk.length < 64 * 1024) {
					chunk += `${JSON.stringify({
						type: "message",
						message: { role: "user", content: [{ type: "text", text: sentence(rng) }] },
					})}\n`;
				}
				const repeats = Math.ceil(target / chunk.length);
				writeFileSync(file, chunk.repeat(repeats).slice(0, target), "utf8");
			}
		}
		const sessions = await import("../../extensions/sessions/index.ts");
		const medianMs = bench(
			() => sessions.searchSessions("zzz-no-such-needle", root, 8).length,
			3,
			0,
		);
		if (!Number.isFinite(medianMs)) fail("sessions-search-nohit: non-finite median");
		rows.push({
			axis: "sessions-search-nohit",
			medianMs,
			iterations: 3,
			note: 'searchSessions("zzz-no-such-needle", tree, 8), 30 dirs × 3 transcripts, one 8 MB',
		});
	}

	// --- transcript-reparse-5mb ----------------------------------------------
	// transcriptItems is cached per session on file mtime; appending one entry
	// invalidates the cache, so the next call re-reads and re-parses the whole
	// transcript. Per session: two warm calls, one appended line, a forced
	// mtime bump, then the timed third call. Median over three ~5 MB sessions.
	{
		const root = fixtureDir("transcript-root");
		process.env.PI_CODING_AGENT_SESSION_DIR = root;
		const transcript = await import("../../extensions/transcript.ts");
		const projectDir = path.join(root, "--bench-project--");
		mkdirSync(projectDir, { recursive: true });
		const thirdCalls = [];
		for (let s = 0; s < 3; s++) {
			const sessionId = uuidLike(1000 + s);
			const file = path.join(projectDir, `2026-10-02T00-00-00_${sessionId}.jsonl`);
			let chunk = "";
			let call = 0;
			for (let i = 0; chunk.length < 5 * 1024 * 1024; i++) {
				const kind = i % 4;
				let record;
				if (kind === 0) {
					record = {
						type: "message",
						message: {
							role: "user",
							content: [{ type: "text", text: `${sentence(rng)} ${sentence(rng)}` }],
						},
					};
				} else if (kind === 1) {
					call += 1;
					record = {
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: sentence(rng) },
								{
									type: "toolCall",
									id: `call-${call}`,
									name: "read",
									arguments: { path: "/repo/src/module.ts" },
								},
							],
						},
					};
				} else if (kind === 2) {
					record = {
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: `call-${call}`,
							content: [{ type: "text", text: `${sentence(rng)}\n`.repeat(12) }],
							isError: false,
							details: { lines: 48 },
						},
					};
				} else {
					record = {
						type: "custom",
						customType: "torus.work-ledger",
						data: { event: "note", text: sentence(rng) },
					};
				}
				chunk += `${JSON.stringify(record)}\n`;
			}
			writeFileSync(file, chunk, "utf8");
			transcript.transcriptItems(sessionId, 60);
			transcript.transcriptItems(sessionId, 60);
			appendFileSync(
				file,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "one more turn after the append" }],
					},
				})}\n`,
				"utf8",
			);
			// mtime granularity could mask the append; bump it deterministically
			utimesSync(file, new Date(), new Date(Date.now() + 1000));
			const start = performance.now();
			transcript.transcriptItems(sessionId, 60);
			thirdCalls.push(performance.now() - start);
		}
		const medianMs = median(thirdCalls);
		if (!Number.isFinite(medianMs)) fail("transcript-reparse-5mb: non-finite sample");
		rows.push({
			axis: "transcript-reparse-5mb",
			medianMs,
			iterations: 3,
			note: "transcriptItems(sessionId, 60) third call after a one-line append, ~5 MB transcript",
		});
	}

	// --- mailbox-fullread-2mb vs mailbox-stat-only ---------------------------
	// The team-poll shape: today a 2 MB mailbox file is read in full and only
	// a prefix is used; the size check alone is one stat. Median over 100
	// iterations each, on the same fixture file.
	{
		const dir = fixtureDir("mailbox");
		const file = path.join(dir, "mailbox.jsonl");
		let chunk = "";
		while (chunk.length < 64 * 1024)
			chunk += `${JSON.stringify({ event: "note", text: sentence(rng) })}\n`;
		writeFileSync(file, chunk.repeat(32).slice(0, 2 * 1024 * 1024), "utf8");
		const fullReadMs = bench(
			() => {
				readFileSync(file, "utf8").slice(0, 4096);
			},
			100,
			5,
		);
		const statOnlyMs = bench(
			() => {
				statSync(file);
			},
			100,
			5,
		);
		if (!Number.isFinite(fullReadMs) || !Number.isFinite(statOnlyMs)) {
			fail("mailbox: non-finite median");
		}
		rows.push({
			axis: "mailbox-fullread-2mb",
			medianMs: fullReadMs,
			iterations: 100,
			note: "readFileSync 2 MB + slice(0, 4096)",
		});
		rows.push({
			axis: "mailbox-stat-only",
			medianMs: statOnlyMs,
			iterations: 100,
			note: "statSync alone",
		});
	}

	if (rows.length !== 10) fail(`expected 10 axes, produced ${rows.length}`);

	const report = {
		meta: {
			date: new Date().toISOString(),
			node: process.version,
			platform: `${process.platform}/${process.arch}`,
		},
		axes: rows.map(({ axis, medianMs, iterations, detail }) =>
			detail === undefined
				? { axis, medianMs, iterations }
				: { axis, medianMs, iterations, detail },
		),
	};
	console.log(JSON.stringify(report, null, 2));
	console.log();
	console.log("---");
	console.log();
	console.log(
		`# local-ops microbench — ${report.meta.platform}, node ${report.meta.node}, ${report.meta.date}`,
	);
	console.log();
	console.log(
		"Median per-call milliseconds per axis; fixtures are deterministic and isolated under a tmpdir.",
	);
	console.log();
	console.log("| axis | median ms | samples | notes |");
	console.log("| ---- | --------: | ------: | ----- |");
	for (const row of rows) {
		console.log(`| \`${row.axis}\` | ${fmtMs(row.medianMs)} | ${row.iterations} | ${row.note} |`);
	}
}

function fmtMs(ms) {
	if (ms >= 100) return ms.toFixed(1);
	if (ms >= 1) return ms.toFixed(3);
	return ms.toFixed(4);
}

main().catch((error) => {
	fail("unhandled fixture or measurement failure", error);
});
