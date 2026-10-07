// Engine execution layer for the bench: argv construction, one JSON-mode
// engine spawn, and event-stream folding. Aggregation deliberately goes
// through the shared reduceEngineEvent pipeline (extensions/engine-child.ts)
// — the same reducer roster/team/fleet consume — so bench tallies can never
// drift from production semantics.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
	childExtensionArgs,
	parseEngineEvent,
	reduceEngineEvent,
} from "../../extensions/engine-child.ts";

export const CONFIGS = ["stock", "torus"];

const STDERR_CAP = 4000;

/**
 * Engine argv for one bench config. Stock is the bare engine in JSON mode;
 * torus appends the canonical child extension set (exactly what delegations
 * get from childExtensionArgs). Unknown configs throw.
 * @param {string} config
 * @param {string} model
 * @param {string} prompt
 * @param {string} root
 */
export function buildArgs(config, model, prompt, root) {
	const base = ["--mode", "json", "--model", model, "-p", prompt];
	if (config === "torus") return [...base, ...childExtensionArgs(root)];
	if (config === "stock") return base;
	throw new Error(`unknown bench config: ${config}`);
}

/**
 * Fold a run's JSONL event lines into one tally: turns, input/output tokens,
 * cache read/write tokens, and engine-computed cost. Unparseable or
 * non-object lines are counted in `malformed` and skipped — never fatal.
 * @param {string[]} eventLines
 */
export function aggregateEventLines(eventLines) {
	const tally = {
		turns: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		text: "",
	};
	let malformed = 0;
	for (const line of eventLines) {
		const record = parseEngineEvent(line);
		if (record === null) {
			malformed += 1;
			continue;
		}
		reduceEngineEvent(record, tally);
	}
	return {
		turns: tally.turns,
		tokensIn: tally.tokensIn,
		tokensOut: tally.tokensOut,
		cacheRead: tally.cacheRead,
		cacheWrite: tally.cacheWrite,
		cost: tally.cost,
		malformed,
	};
}

/**
 * Spawn the engine once and collect its JSONL event lines. Resolves with
 * { exitCode, stderr, lines, timedOut, spawnError }; never rejects — callers
 * decide what counts as failure. stderr is capped at STDERR_CAP bytes so a
 * crashing run cannot balloon memory.
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 */
export function runEngineOnce(bin, args, cwd, env, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let buffer = "";
		const lines = [];
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			buffer += stdoutDecoder.write(chunk);
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				lines.push(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length >= STDERR_CAP) return;
			stderr += stderrDecoder.write(chunk).slice(0, STDERR_CAP - stderr.length);
		});
		const finish = (exitCode, spawnError) => {
			clearTimeout(timer);
			buffer += stdoutDecoder.end();
			if (buffer.length > 0) lines.push(buffer);
			resolve({ exitCode, stderr: stderr + stderrDecoder.end(), lines, timedOut, spawnError });
		};
		child.on("error", (err) => finish(1, err));
		child.on("close", (code) => finish(code ?? 1));
	});
}
