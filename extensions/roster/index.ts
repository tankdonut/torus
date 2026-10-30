/**
 * torus — agent roster, delegation tool, and per-agent commands.
 *
 * Delegation uses pi's canonical subagent pattern: spawn the engine itself in
 * JSON mode (`<engine> --mode json -p --no-session --model <m>`) and consume
 * the JSONL event stream on stdout.
 *
 * Three levers surface the roster:
 *   - torus_roster / torus_delegate / torus_results tools (model-driven)
 *   - /roster, /leader, /explorer, /builder, /reviewer commands (user-driven;
 *     they inject a user message so results land in the conversation)
 *   - system-prompt roster section (prompts.ts) telling the model when to
 *     delegate
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, loadSkills } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AcpAgentSpec, acpAgents, runAcpAgent } from "../acp/index.js";
import { knobBoolean, parseZeroDisables } from "../config/knobs.js";
import {
	childExtensionArgs,
	type EngineTally,
	engineChildEnv,
	parseEngineEvent,
	reduceEngineEvent,
	resolveEngineBin,
	sessionIdFromState,
} from "../engine-child.js";
import { flattenPreview, formatDuration, shortModel } from "../fleet/theme-kit.js";
import { parseFrontmatter, stripFrontmatter } from "../frontmatter.js";
import { formatCost, sleep, splitList } from "../fsutil.js";
import { clickable } from "../notify/index.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import {
	type ChainTier,
	modelChain,
	modelConcurrencyMap,
	providerAvailabilities,
} from "../providers/index.js";
import {
	AGENT_NAME_RE,
	appendAction,
	attachControl,
	attachSessionId,
	type DelegationRecord,
	delegationStopRequested,
	emitTorusCustom,
	finishDelegation,
	listDelegations,
	RECORD_TEXT_CAP,
	readFullRecordText,
	redactSecrets,
	registryShutdown,
	rehydrateFromLogs,
	repoRoot,
	setCurrentSession,
	setCustomSender,
	setDelegationModel,
	setSessionPersona,
	startDelegation,
	updateDelegation,
} from "../registry.js";
import { RpcChild } from "../rpc.js";
import { queueWakeEntry, wakeGateAgentSettled, wakeGateAgentStart } from "../wake-gate.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
	deps: [{ name: "tmux", required: false, note: "optional delegation panes and fleet views" }],
};

interface AgentDef {
	name: string;
	description: string;
	chain: ChainTier;
	mode?: "child" | "session";
	promptFile?: string;
	promptBody?: string;
	tools?: string[];
	commandAliases?: string[];
	model?: string;
}

const AGENTS_DIR = path.join(repoRoot(), "agents");
const STDERR_CAP = 64 * 1024;

const QUIESCE_TIMEOUT_MS = 600_000;
const QUIESCE_POLL_MS = 500;

export function parseAgentFile(fileName: string, raw: string): AgentDef | null {
	const parsed = parseFrontmatter(raw);
	if (!parsed) return null;
	const fields = parsed.fields;
	const description = fields.get("description");
	if (!description) return null;
	const tools = splitList(fields.get("tools"));
	const aliases = splitList(fields.get("aliases"));
	const explicitModel = fields.get("model")?.trim();
	const name = fields.get("name") ?? path.basename(fileName, ".md");
	if (!AGENT_NAME_RE.test(name)) return null;
	return {
		name,
		description,
		chain: fields.get("chain") === "fast" ? "fast" : "primary",
		mode: fields.get("mode") === "session" ? "session" : "child",
		promptFile: fileName,
		promptBody: parsed.body,
		tools: tools.length > 0 ? tools : undefined,
		commandAliases: aliases.length > 0 ? aliases : undefined,
		model: explicitModel && explicitModel.length > 0 ? explicitModel : undefined,
	};
}

function loadAgents(): AgentDef[] {
	const defs: AgentDef[] = [];
	for (const fileName of readdirSync(AGENTS_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort()) {
		const parsed = parseAgentFile(fileName, readFileSync(path.join(AGENTS_DIR, fileName), "utf8"));
		if (parsed) defs.push(parsed);
	}
	return defs;
}

export const AGENTS: AgentDef[] = loadAgents();

const DELEGATABLE = AGENTS.filter((a) => a.mode !== "session");

function firstDelegatable(name: string): AgentDef | undefined {
	return DELEGATABLE.find((a) => a.name === name);
}

export function resolveModels(chain: ChainTier): string[] {
	const available = providerAvailabilities();
	return modelChain(chain).filter((model) => {
		const provider = model.split("/")[0];
		return (
			provider !== undefined &&
			provider in available &&
			available[provider as keyof typeof available]
		);
	});
}

function resolveModel(chain: ChainTier): string | undefined {
	return resolveModels(chain)[0];
}

/** Model ids a delegation may run on right now: every chain candidate whose provider is credentialed. */
export function availableModels(): string[] {
	return [...new Set([...resolveModels("primary"), ...resolveModels("fast")])];
}

/**
 * Resolve a per-run model override: "primary"/"fast" name a chain (resolved to
 * its first credentialed candidate), anything else must be an exact id in the
 * available set. Returns the concrete id, or undefined when nothing matches.
 */
export function resolveRequestedModel(requested: string): string | undefined {
	if (requested === "primary" || requested === "fast") return resolveModel(requested);
	return availableModels().includes(requested) ? requested : undefined;
}

export function personaModel(name: string): string | null {
	const agent = AGENTS.find((a) => a.name === name);
	if (!agent) return null;
	return agent.model ?? resolveModel(agent.chain) ?? null;
}

/**
 * The model a planned delegation run would start on: explicit override, else
 * the agent's frontmatter pin when credentialed, else its chain head — the
 * same first-model resolution runDelegation performs.
 */
export function plannedRunModel(agentName: string, requested?: string): string | undefined {
	const trimmed = requested?.trim();
	if (trimmed) return resolveRequestedModel(trimmed);
	const agent = DELEGATABLE.find((a) => a.name === agentName);
	if (!agent) return undefined;
	if (agent.model && availableModels().includes(agent.model)) return agent.model;
	return resolveModel(agent.chain);
}

/**
 * Pre-flight oversubscription warning for planned runs: per model, running
 * delegations (registry snapshot) plus the planned starts are compared with
 * the model's concurrency cap. One actionable paragraph when any model lands
 * over cap, undefined otherwise. `active` replaces the registry snapshot
 * (test seam).
 */
export function concurrencyWarning(
	planned: (string | undefined)[],
	active?: Record<string, number>,
): string | undefined {
	const caps = modelConcurrencyMap();
	const counts: Record<string, number> = {};
	if (active === undefined) {
		for (const record of listDelegations()) {
			if (record.status === "running") counts[record.model] = (counts[record.model] ?? 0) + 1;
		}
	} else {
		for (const [model, count] of Object.entries(active)) counts[model] = count;
	}
	for (const model of planned) {
		if (model !== undefined) counts[model] = (counts[model] ?? 0) + 1;
	}
	const over = Object.entries(counts)
		.filter(([model, count]) => count > (caps[model] ?? Number.POSITIVE_INFINITY))
		.map(([model, count]) => `${model}: ${count} parallel runs vs cap ${caps[model]}`);
	if (over.length === 0) return undefined;
	return (
		`warning: provider concurrency cap exceeded — ${over.join("; ")}. Caps are ` +
		`account-level concurrent-session limits (torus_roster reports them; override per ` +
		`model via the chains config's "concurrency" map): oversubscribed models get ` +
		`HTTP 429 / code 1302 rejections or queue server-side. Shift some runs to another ` +
		`model or stagger them (the lead session's own requests count against the same cap).`
	);
}

/** Prepend a concurrency warning to delegation result text. */
export function withWarning(text: string, warning: string | undefined): string {
	return warning === undefined ? text : `${warning}\n\n${text}`;
}

function piAgentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent");
}

function agentsSkillDirs(cwd: string): string[] {
	return [path.resolve(cwd, ".agents", "skills"), path.join(homedir(), ".agents", "skills")];
}

/**
 * Skill dirs the torus package manifest declares (payload package.json →
 * pi.skills), resolved against repoRoot(). The launcher starts the main window
 * as `pi --extension <payload-root>` and pi loads a package's full manifest —
 * extensions AND skills — so this is exactly the skill set the main window has.
 * Delegation children are spawned with bare extension files (no manifest), and
 * a delegation-cwd package.json is one the main window never loaded — resolving
 * from either would break parity in both directions.
 */
function payloadSkillPaths(): string[] {
	const root = repoRoot();
	try {
		const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
			pi?: { skills?: unknown };
		};
		const skills = pkg.pi?.skills;
		if (!Array.isArray(skills)) return [];
		return skills
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => path.resolve(root, entry));
	} catch {
		return [];
	}
}

function discoveredSkillMap(cwd: string): Map<string, string> {
	const discovered = new Map<string, string>();
	for (const skill of loadSkills({
		cwd,
		agentDir: piAgentDir(),
		skillPaths: payloadSkillPaths(),
		includeDefaults: true,
	}).skills) {
		discovered.set(skill.name, skill.filePath);
	}
	return discovered;
}

/**
 * Skill roots a delegated child may load from: pi's discovered skill dirs
 * plus the explicit .pi/.agents locations. A path that merely exists on disk
 * is not automatically a skill — containment keeps the child's --skill
 * loader from being pointed at arbitrary directories.
 */
function skillRoots(cwd: string, discovered: Map<string, string>): string[] {
	const roots = [
		path.join(piAgentDir(), "skills"),
		path.resolve(cwd, ".pi", "skills"),
		...agentsSkillDirs(cwd),
	];
	for (const filePath of discovered.values()) roots.push(path.dirname(filePath));
	return roots;
}

function isUnder(childPath: string, roots: string[]): boolean {
	for (const root of roots) {
		const rel = path.relative(root, childPath);
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

export function resolveSkillPaths(
	entries: string[],
	cwd: string,
): { paths: string[]; missing: string[]; rejected: string[] } {
	const paths: string[] = [];
	const missing: string[] = [];
	const rejected: string[] = [];
	const discovered = discoveredSkillMap(cwd);
	const roots = skillRoots(cwd, discovered);
	for (const entry of entries) {
		const raw = entry.trim();
		if (raw.length === 0) continue;
		const direct = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
		if (existsSync(direct)) {
			if (isUnder(direct, roots)) paths.push(direct);
			else rejected.push(raw);
			continue;
		}
		const discoveredPath = discovered.get(raw);
		if (discoveredPath) {
			paths.push(discoveredPath);
			continue;
		}
		const fromAgentsDirs = agentsSkillDirs(cwd)
			.flatMap((dir) => [
				path.join(dir, raw),
				path.join(dir, raw, "SKILL.md"),
				`${path.join(dir, raw)}.md`,
			])
			.find((candidate) => existsSync(candidate));
		if (fromAgentsDirs) paths.push(fromAgentsDirs);
		else missing.push(raw);
	}
	return { paths, missing, rejected };
}

function availableSkillNames(cwd: string): string[] {
	const names = new Set<string>();
	for (const skill of loadSkills({
		cwd,
		agentDir: piAgentDir(),
		skillPaths: payloadSkillPaths(),
		includeDefaults: true,
	}).skills) {
		names.add(skill.name);
	}
	for (const dir of agentsSkillDirs(cwd)) {
		try {
			for (const entry of readdirSync(dir)) names.add(entry.replace(/\.md$/, ""));
		} catch {
			// missing skills dir is fine
		}
	}
	return [...names].sort();
}

function systemPromptFor(agent: AgentDef): string {
	const body = agent.promptBody;
	if (!body) {
		return `TORUS AGENT: ${agent.name}\nROLE: ${agent.description}\n`;
	}
	return substituteMarkers(stripFrontmatter(body));
}

function substituteMarkers(prompt: string): string {
	const rosterBlock = DELEGATABLE.map((a) => `- ${a.name} — ${a.description}`).join("\n");
	return prompt
		.replaceAll("{{AGENTS}}", `Available agents:\n${rosterBlock}`)
		.replaceAll("{{DELEGATION}}", `Delegation table:\n${rosterBlock}`)
		.replaceAll("{{TOOLS}}", "")
		.replaceAll("{{SKILLS}}", "")
		.replaceAll("{{DYNAMIC}}", "");
}

export function rosterText(): string {
	const available = providerAvailabilities();
	const providers = `providers: zai=${available.zai} opencode-go=${available["opencode-go"]}`;
	const agents = DELEGATABLE.map((agent) => {
		const model = resolveModel(agent.chain) ?? "NO-CREDENTIALED-MODEL";
		return `${agent.name}: ${agent.description} [chain=${agent.chain} -> ${model}]`;
	});
	const lines = [providers, ...agents];
	const caps = availableModels()
		.map((model) => `${model}=${modelConcurrencyMap()[model] ?? "uncapped"}`)
		.join(", ");
	lines.push(`concurrency caps (max parallel runs per model, provider account-level): ${caps}`);
	const acp = Object.keys(acpAgents()).sort();
	if (acp.length > 0) lines.push(`acp agents (external, own models): ${acp.join(", ")}`);
	return lines.join("\n");
}

interface SpawnResult {
	exitCode: number;
	finalText: string;
	stderr: string;
	sessionId: string | null;
	usage: {
		input: number;
		output: number;
		turns: number;
		cacheRead: number;
		cacheWrite: number;
		/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
		cost: number;
		/** Trailing assistant turns with no token delta and no text change. */
		noProgressTail: number;
		/** Most recent engine-signaled model-error text, if the run ended in one. */
		lastError?: string;
	};
	seenToolCalls: Set<string>;
	seenToolResults: Set<string>;
}

export interface DelegationSnapshot {
	text: string;
	turns: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		/** Engine-computed dollar cost; 0 when the model has no catalog pricing. */
		cost: number;
	};
	/** Registry id of the run; injected by runDelegation before onTurn fires. */
	delegationId?: string;
}

async function runEngineRpc(
	args: string[],
	cwd: string,
	task: string,
	onTurn?: (snapshot: DelegationSnapshot) => void,
	onAction?: (line: string) => void,
	onControl?: (control: { stop: () => void; steer: (text: string) => boolean }) => void,
	onSession?: (sessionId: string) => void,
): Promise<SpawnResult> {
	const engineBin = resolveEngineBin();
	const result: SpawnResult = {
		exitCode: 0,
		finalText: "",
		stderr: "",
		sessionId: null,
		usage: {
			input: 0,
			output: 0,
			turns: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			noProgressTail: 0,
		},
		seenToolCalls: new Set(),
		seenToolResults: new Set(),
	};
	let settleResolve: (() => void) | null = null;
	const settled = new Promise<void>((resolve) => {
		settleResolve = resolve;
	});

	const child = new RpcChild(engineBin, args, cwd, {
		onEvent: (event) => {
			const before = result.usage.turns;
			consumeEventLine(event, result, onAction);
			if (onTurn && result.usage.turns > before) {
				onTurn({
					text: result.finalText,
					turns: result.usage.turns,
					usage: { ...result.usage },
				});
			}
		},
		onSettled: () => settleResolve?.(),
	});
	onControl?.({
		stop: () => child.kill(),
		steer: (text) => {
			if (!child.steerable) {
				onAction?.("~ steer FAILED child not accepting input");
				return false;
			}
			void child
				.steer(text)
				.then((response) => {
					const ok = response["success"] === true;
					const data = (response["data"] ?? {}) as Record<string, unknown>;
					const disposition =
						typeof data["disposition"] === "string" ? data["disposition"] : "accepted";
					onAction?.(`~ steer ${ok ? disposition : `REJECTED (${disposition})`}`);
				})
				.catch((err) => onAction?.(`~ steer FAILED ${String(err).slice(0, 120)}`));
			return true;
		},
	});

	let settledFirst = false;
	try {
		const sessionId = sessionIdFromState(await child.getState());
		if (sessionId) {
			result.sessionId = sessionId;
			onSession?.(sessionId);
		}

		await child.prompt(task);
		settledFirst = await Promise.race([settled.then(() => true), child.exited.then(() => false)]);
		if (child.stderrText) result.stderr = child.stderrText.slice(0, 2000);
	} finally {
		child.kill();
	}
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	const exitCode = await Promise.race([
		child.exited,
		new Promise<number>((r) => {
			exitTimer = setTimeout(() => {
				child.kill("SIGKILL");
				r(143);
			}, 2000);
		}),
	]);
	clearTimeout(exitTimer);
	// A settled agent finished its work; the SIGTERM shutdown exit (143) is not a task failure.
	result.exitCode = settledFirst ? 0 : exitCode;
	if (result.exitCode === 0 && !result.finalText && result.usage.turns === 0) result.exitCode = 1;
	return result;
}

async function runEngineJson(
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onTurn?: (snapshot: DelegationSnapshot) => void,
	onAction?: (line: string) => void,
	onSpawned?: (stop: () => void) => void,
	onSession?: (sessionId: string) => void,
): Promise<SpawnResult> {
	const engineBin = resolveEngineBin();
	// A stop that aborted the signal before this fallback spawned (an operator
	// stop during the RPC handshake) must not run the task in JSON mode after
	// the cancellation — an already-aborted signal never fires its listener.
	if (signal?.aborted) {
		return {
			exitCode: 143,
			finalText: "",
			stderr: "stopped before the fallback engine spawned",
			sessionId: null,
			usage: {
				input: 0,
				output: 0,
				turns: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				noProgressTail: 0,
			},
			seenToolCalls: new Set(),
			seenToolResults: new Set(),
		};
	}
	const result: SpawnResult = {
		exitCode: 0,
		finalText: "",
		stderr: "",
		sessionId: null,
		usage: {
			input: 0,
			output: 0,
			turns: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			noProgressTail: 0,
		},
		seenToolCalls: new Set(),
		seenToolResults: new Set(),
	};
	let sessionReported = false;
	const reportSession = (): void => {
		if (sessionReported || !result.sessionId) return;
		sessionReported = true;
		onSession?.(result.sessionId);
	};

	await new Promise<void>((resolve) => {
		const child = spawn(engineBin, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: engineChildEnv(),
		});
		onSpawned?.(() => child.kill("SIGTERM"));
		let buffer = "";
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			buffer += stdoutDecoder.write(chunk);
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const record = parseEngineEvent(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (record) {
					const before = result.usage.turns;
					consumeEventLine(record, result, onAction);
					if (result.sessionId) reportSession();
					if (onTurn && result.usage.turns > before) {
						onTurn({
							text: result.finalText,
							turns: result.usage.turns,
							usage: { ...result.usage },
						});
					}
				}
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (result.stderr.length >= STDERR_CAP) return;
			result.stderr += stderrDecoder.write(chunk).slice(0, STDERR_CAP - result.stderr.length);
		});
		child.on("error", (err) => {
			result.stderr += String(err);
			result.exitCode = 1;
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", abort);
			buffer += stdoutDecoder.end();
			result.stderr += stderrDecoder.end().slice(0, STDERR_CAP - result.stderr.length);
			const tailRecord = parseEngineEvent(buffer);
			if (tailRecord) consumeEventLine(tailRecord, result);
			result.exitCode = code ?? result.exitCode;
			resolve();
		});
	});

	return result;
}

export function consumeEventLine(
	record: Record<string, unknown>,
	result: SpawnResult,
	onAction?: (line: string) => void,
): void {
	if (record["type"] === "session" && typeof record["id"] === "string") {
		result.sessionId = record["id"];
		return;
	}
	if (onAction) emitToolActions(record, result, onAction);
	const tally: EngineTally = {
		turns: result.usage.turns,
		tokensIn: result.usage.input,
		tokensOut: result.usage.output,
		cacheRead: result.usage.cacheRead,
		cacheWrite: result.usage.cacheWrite,
		cost: result.usage.cost,
		text: result.finalText,
		noProgressTail: result.usage.noProgressTail ?? 0,
		lastError: result.usage.lastError,
	};
	reduceEngineEvent(record, tally);
	result.usage.turns = tally.turns;
	result.usage.input = tally.tokensIn;
	result.usage.output = tally.tokensOut;
	result.usage.cacheRead = tally.cacheRead;
	result.usage.cacheWrite = tally.cacheWrite;
	result.usage.cost = tally.cost;
	result.usage.noProgressTail = tally.noProgressTail ?? 0;
	result.usage.lastError = tally.lastError;
	result.finalText = tally.text;
}

function summarizeToolCall(name: unknown, args: unknown): string {
	const tool = typeof name === "string" && name.length > 0 ? name : "tool";
	if (typeof args === "object" && args !== null) {
		const argMap = args as Record<string, unknown>;
		for (const key of ["path", "file_path", "command", "pattern", "url", "query"]) {
			const value = argMap[key];
			if (typeof value === "string" && value.length > 0) {
				return redactSecrets(`${tool} ${key}=${flattenPreview(value, 60)}`);
			}
		}
	}
	return tool;
}

function summarizeToolResult(isError: boolean): string {
	return isError ? "result (error)" : "result";
}

const callId = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/**
 * Tool-call action lines for the delegation log. The engine reports tool
 * activity twice — dedicated tool_execution_* events (RPC mode only) and
 * camelCase toolCall blocks / toolResult-role messages inside message_end
 * (both modes) — so each direction is deduped per toolCallId.
 */
function emitToolActions(
	record: Record<string, unknown>,
	result: SpawnResult,
	onAction: (line: string) => void,
): void {
	if (record["type"] === "tool_execution_start") {
		const id = callId(record["toolCallId"]);
		if (id) {
			if (result.seenToolCalls.has(id)) return;
			result.seenToolCalls.add(id);
		}
		onAction(`→ ${summarizeToolCall(record["toolName"], record["args"])}`);
		return;
	}
	if (record["type"] === "tool_execution_end") {
		const id = callId(record["toolCallId"]);
		if (id) {
			if (result.seenToolResults.has(id)) return;
			result.seenToolResults.add(id);
		}
		onAction(`← ${summarizeToolResult(record["isError"] === true)}`);
		return;
	}
	if (
		record["type"] !== "message_end" ||
		typeof record["message"] !== "object" ||
		record["message"] === null
	)
		return;
	const message = record["message"] as Record<string, unknown>;
	if (message["role"] === "assistant" && Array.isArray(message["content"])) {
		for (const block of message["content"]) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as Record<string, unknown>;
			if (b["type"] !== "toolCall") continue;
			const id = callId(b["id"]);
			if (id) {
				if (result.seenToolCalls.has(id)) continue;
				result.seenToolCalls.add(id);
			}
			onAction(`→ ${summarizeToolCall(b["name"], b["arguments"])}`);
		}
		return;
	}
	if (message["role"] === "toolResult") {
		const id = callId(message["toolCallId"]);
		if (id) {
			if (result.seenToolResults.has(id)) return;
			result.seenToolResults.add(id);
		}
		onAction(`← ${summarizeToolResult(message["isError"] === true)}`);
	}
}

export interface DelegationOutcome {
	ok: boolean;
	text: string;
	details: Record<string, unknown>;
	/** Registry id of this run; null on pre-flight rejections (no run started). */
	delegationId: string | null;
}

/** One background run: enough context to label and time its completion wake. */
export interface BackgroundRunDescriptor {
	agent: string;
	handle: string | null;
	/** Starts the run; MUST invoke runDelegation with emitResult=false — the wake gate is the only delivery path for background results. */
	start: () => Promise<DelegationOutcome>;
}

/** Summary cap for a completion wake: the marker is context, torus_results carries the full tail. */
const BACKGROUND_SUMMARY_CAP = 4000;

/**
 * Fire delegation runs without awaiting them; each completion queues ONE
 * wake-gate entry (customType torus.delegation-result carrying the result
 * summary): an idle session gets it immediately, a busy one gets every
 * pending completion batched into a single turn at settle. Returns each
 * run's settled promise so tests may await them; callers in the tool path
 * must not.
 */
export function fireDelegationsBackground(
	runs: BackgroundRunDescriptor[],
): Array<Promise<DelegationOutcome>> {
	return runs.map((run) => {
		const startedAt = Date.now();
		const settled = run.start().catch(
			(error): DelegationOutcome => ({
				ok: false,
				text: `background delegation crashed: ${String(error).slice(0, 300)}`,
				details: { error: "background-crash", agent: run.agent },
				delegationId: null,
			}),
		);
		return settled.then((outcome) => {
			try {
				const record = outcome.delegationId
					? listDelegations().find((r) => r.id === outcome.delegationId)
					: undefined;
				const summary =
					outcome.text.length > BACKGROUND_SUMMARY_CAP
						? `${outcome.text.slice(0, BACKGROUND_SUMMARY_CAP)}…`
						: outcome.text;
				const label = run.handle ? `@${run.handle} (${run.agent})` : run.agent;
				queueWakeEntry({
					customType: "torus.delegation-result",
					text: `[torus] ${label} background delegation ${outcome.ok ? "finished" : "FAILED"}. Full result:\n\n${summary}\n\nFull output: run torus_results${outcome.delegationId ? ` with id ${outcome.delegationId}` : " and pick this run"}.${record ? ` Log: ${record.logFile}` : ""}`,
					details: {
						agent: run.agent,
						handle: run.handle,
						ok: outcome.ok,
						background: true,
						...(outcome.delegationId ? { delegationId: outcome.delegationId } : {}),
						durationMs: Date.now() - startedAt,
					},
				});
			} catch {
				// Delivery is best-effort; the registry record and log keep the result.
			}
			return outcome;
		});
	});
}

/**
 * Content for a delegation's start marker: null suppresses it, true previews
 * the task text, and a caller-supplied string is used verbatim so background
 * runs can announce themselves without leaking dreamer-directed task text
 * into the parent model's context.
 */
export function announceText(announce: boolean | string, task: string): string | null {
	if (announce === false) return null;
	return (typeof announce === "string" ? announce : task).slice(0, 400);
}

/**
 * ACP delegation: an external agent from acp.json run through the AcpChild
 * transport. No engine spawn, no model chain, no skills — the agent brings
 * its own model, so usage/cost are best-effort zeros and the registry model
 * label is an `acp/<name>` marker rather than a resolved id.
 */
async function runAcpDelegation(
	agentName: string,
	spec: AcpAgentSpec,
	task: string,
	cwd: string | undefined,
	onTurn: ((snapshot: DelegationSnapshot) => void) | undefined,
	parentSession: string | null,
	handle: string | null,
	skills: string[] | null,
	announce: boolean | string,
	emitResult: boolean,
): Promise<DelegationOutcome> {
	if (skills && skills.length > 0) {
		return {
			ok: false,
			text: `Agent "${agentName}" runs as an external ACP process — skills apply only to engine agents. Pass the needed context in the task text.`,
			details: { error: "acp-skills-unsupported", agent: agentName },
			delegationId: null,
		};
	}
	const workingDir = cwd ?? process.cwd();
	const startedAt = Date.now();
	const delegationId = randomUUID();
	const modelLabel = `acp/${agentName}`;
	await startDelegation(delegationId, agentName, modelLabel, parentSession, handle);
	const announcement = announceText(announce, task);
	if (announcement !== null) {
		emitTorusCustom(
			{
				customType: "torus.delegation-start",
				content: [{ type: "text", text: announcement }],
				display: true,
				details: { agent: agentName, delegationId, handle },
			},
			{ triggerTurn: false },
		);
	}
	const onActionWrapped = (actionLine: string) => appendAction(delegationId, actionLine);
	try {
		const run = await runAcpAgent(agentName, spec, workingDir, task, {
			onAction: onActionWrapped,
			onSession: (sessionId) => attachSessionId(delegationId, sessionId),
			onControl: (control) =>
				attachControl(delegationId, { stop: control.stop, steer: () => false }),
		});
		const text = run.ok
			? run.finalText
			: `${run.finalText}${run.finalText ? "\n" : ""}[acp failure: ${run.stopReason}]${
					run.stderr ? `\n${run.stderr.slice(0, 2000)}` : ""
				}`;
		if (run.turns > 0) {
			updateDelegation(delegationId, {
				text: run.finalText,
				turns: run.turns,
				usage: { input: 0, output: 0 },
			});
			onTurn?.({
				text: run.finalText,
				turns: run.turns,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				delegationId,
			});
		}
		await finishDelegation(delegationId, run.ok, text, run.sessionId);
		if (emitResult) {
			emitTorusCustom(
				{
					customType: "torus.delegation-result",
					content: [
						{
							type: "text",
							text: `${agentName} ${run.ok ? "finished" : "failed"}`,
						},
					],
					display: true,
					details: {
						agent: agentName,
						ok: run.ok,
						delegationId,
						sessionId: run.sessionId,
						handle,
						durationMs: Date.now() - startedAt,
						turns: run.turns,
						stopReason: run.stopReason,
					},
				},
				{ triggerTurn: false },
			);
		}
		return {
			ok: run.ok,
			text,
			delegationId,
			details: {
				agent: agentName,
				model: modelLabel,
				exitCode: run.ok ? 0 : 1,
				sessionId: run.sessionId,
				delegationId,
				turns: run.turns,
				stopReason: run.stopReason,
				usage: {
					input: 0,
					output: 0,
					turns: run.turns,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
				},
			},
		};
	} catch (runError) {
		// Crash path mirrors the engine branch: finish best-effort so a start
		// marker is never stranded without a failure marker, then rethrow.
		try {
			await finishDelegation(delegationId, false, `acp delegation crashed: ${String(runError)}`);
		} catch {
			// registry finish failed (e.g. log unwritable); the marker below still goes out
		}
		if (emitResult) {
			emitTorusCustom(
				{
					customType: "torus.delegation-result",
					content: [{ type: "text", text: `${agentName} failed` }],
					display: true,
					details: {
						agent: agentName,
						ok: false,
						delegationId,
						handle,
						durationMs: Date.now() - startedAt,
						error: String(runError),
					},
				},
				{ triggerTurn: false },
			);
		}
		throw runError;
	}
}

export async function runDelegation(
	agentName: string,
	task: string,
	cwd?: string,
	onTurn?: (snapshot: DelegationSnapshot) => void,
	parentSession: string | null = null,
	handle: string | null = null,
	skills: string[] | null = null,
	/**
	 * Start-marker policy: true previews the task text, false emits no start
	 * marker, and a string is used verbatim — background runs (dream, idle or
	 * turn-triggered reflection) pass neutral text because custom messages
	 * reach the parent model's context as user messages, where a dreamer-
	 * directed task ("You are reflecting…") reads as an instruction.
	 */
	announce: boolean | string = true,
	emitResult = true,
	/**
	 * Per-run overrides. `model` starts the chain walk at a specific model:
	 * "primary"/"fast" (chain shorthands) or an exact available id — validated
	 * before any spawn, invalid values reject pre-flight. Older call sites
	 * (memory background runs) pass announce positionally, so the bag trails.
	 */
	options?: { model?: string | null },
): Promise<DelegationOutcome> {
	// ACP agents from acp.json run their own models and win over same-named
	// roster agents; the engine path below is untouched when acp.json is absent.
	const acpSpec = acpAgents()[agentName];
	if (acpSpec) {
		return runAcpDelegation(
			agentName,
			acpSpec,
			task,
			cwd,
			onTurn,
			parentSession,
			handle,
			skills,
			announce,
			emitResult,
		);
	}
	const agent = firstDelegatable(agentName);
	if (!agent) {
		return {
			ok: false,
			text: `Unknown agent "${agentName}". ${rosterText()}`,
			details: { error: "unknown-agent" },
			delegationId: null,
		};
	}
	const chainModels = resolveModels(agent.chain);
	const chainHead = chainModels[0];
	if (!chainHead) {
		return {
			ok: false,
			text: "No available model in chain. Every entry must name a declared provider: the engine built-ins (zai, opencode-go) or a providers entry in the config's chains section.",
			details: { error: "no-model" },
			delegationId: null,
		};
	}
	const requestedModel = options?.model?.trim() || null;
	let firstModel = chainHead;
	if (requestedModel) {
		const resolved = resolveRequestedModel(requestedModel);
		if (!resolved) {
			return {
				ok: false,
				text: `Invalid model "${requestedModel}". Valid: primary, fast (chain shorthands), ${availableModels().join(", ")}`,
				details: { error: "invalid-model", model: requestedModel },
				delegationId: null,
			};
		}
		// Shorthands resolve here so the registry record carries a real id.
		firstModel = resolved;
	} else if (agent.model && availableModels().includes(agent.model)) {
		// Frontmatter pin; a pin whose provider is unavailable defers to the chain head.
		firstModel = agent.model;
	}
	const attemptModels =
		firstModel === chainHead
			? chainModels
			: [firstModel, ...chainModels.filter((m) => m !== firstModel)];
	const workingDir = cwd ?? process.cwd();
	const resolvedSkills = resolveSkillPaths(skills ?? [], workingDir);
	if (resolvedSkills.rejected.length > 0) {
		return {
			ok: false,
			text: `Skill path outside allowed roots: ${resolvedSkills.rejected.map((s) => `"${s}"`).join(", ")}. Skills must resolve under a skill root (.pi/skills, ~/.pi/agent/skills, .agents/skills, torus package pi.skills, or a discovered skill directory) — pass other content via the task text.`,
			details: { error: "skill-path-outside-roots", skills: resolvedSkills.rejected },
			delegationId: null,
		};
	}
	if (resolvedSkills.missing.length > 0) {
		const names = availableSkillNames(workingDir);
		return {
			ok: false,
			text: `Unknown skill ${resolvedSkills.missing.map((s) => `"${s}"`).join(", ")}. ${names.length > 0 ? `Available: ${names.join(", ")}` : "No skills found"} — or pass a file/directory path.`,
			details: { error: "unknown-skill", skills: resolvedSkills.missing },
			delegationId: null,
		};
	}

	const startedAt = Date.now();
	const root = repoRoot();
	const commonArgs: string[] = [...childExtensionArgs(root)];
	if (agent.tools?.length) commonArgs.push("--tools", agent.tools.join(","));
	for (const skillPath of resolvedSkills.paths) commonArgs.push("--skill", skillPath);

	const promptBody = systemPromptFor(agent);
	const dir = await mkdtemp(path.join(tmpdir(), `torus-${agent.name}-`));
	const delegationId = randomUUID();
	await startDelegation(delegationId, agent.name, firstModel, parentSession, handle, workingDir);
	// Batch callers (fan-out, teams) pass announce=false and emit one combined
	// marker instead of N per-run events staggering across turn boundaries.
	const announcement = announceText(announce, task);
	if (announcement !== null) {
		emitTorusCustom(
			{
				customType: "torus.delegation-start",
				content: [{ type: "text", text: announcement }],
				display: true,
				details: { agent: agent.name, delegationId, handle },
			},
			{ triggerTurn: false },
		);
	}
	if (resolvedSkills.paths.length > 0) {
		appendAction(
			delegationId,
			`→ skills: ${resolvedSkills.paths.map((p) => path.basename(p.replace(/\/SKILL\.md$/, ""), ".md")).join(" · ")}`,
		);
	}
	try {
		const file = path.join(dir, `${delegationId}.md`);
		await writeFile(file, promptBody, "utf8");
		commonArgs.push("--append-system-prompt", file);

		const onTurnWrapped = (snapshot: DelegationSnapshot) => {
			updateDelegation(delegationId, snapshot);
			onTurn?.({ ...snapshot, delegationId });
		};
		const onActionWrapped = (actionLine: string) => appendAction(delegationId, actionLine);

		let result: SpawnResult | null = null;
		let usedModel = firstModel;
		// The delegation's stop signal: stopDelegation aborts it, which kills a
		// JSON-mode fallback child via its abort listener (rpc children are
		// stopped directly through their control).
		const stopController = new AbortController();
		// An operator stop can land between startDelegation and the first child's
		// control attach; this placeholder keeps the abort reachable so an early
		// stop is never lost to that race (the real control replaces it).
		attachControl(delegationId, { stop: () => stopController.abort(), steer: () => false });
		for (const candidate of attemptModels) {
			usedModel = candidate;
			if (candidate !== firstModel) {
				setDelegationModel(delegationId, candidate);
				appendAction(delegationId, `! falling back to ${candidate}`);
			}
			const attemptArgs = ["--model", candidate, ...commonArgs];
			const attempt: SpawnResult = await (async () => {
				try {
					return await runEngineRpc(
						["--mode", "rpc", ...attemptArgs],
						workingDir,
						`Task: ${task}`,
						onTurnWrapped,
						onActionWrapped,
						(control) => attachControl(delegationId, control),
						(sessionId) => attachSessionId(delegationId, sessionId),
					);
				} catch (rpcError) {
					appendAction(
						delegationId,
						`rpc unavailable (${String(rpcError)}) — falling back to json mode`,
					);
					return await runEngineJson(
						["--mode", "json", "-p", ...attemptArgs, `Task: ${task}`],
						workingDir,
						stopController.signal,
						onTurnWrapped,
						onActionWrapped,
						() =>
							attachControl(delegationId, {
								stop: () => stopController.abort(),
								steer: () => false,
							}),
						(sessionId) => attachSessionId(delegationId, sessionId),
					);
				}
			})();
			result = attempt;
			// An operator stop from the fleet view ends the walk: retrying a
			// cancelled run down-chain would respawn it on the next model.
			if (delegationStopRequested(delegationId)) break;
			// Turns alone no longer vouch for an attempt: engine-signaled model
			// errors (the engine already auto-retried and gave up) and a trailing
			// run of no-progress turns are both dead work, so the turns > 0
			// acceptance requires a clean tail and no error signal, and the walk
			// advances down-chain. A zero exit still accepts (the torus:done case)
			// — the outcome gate below turns that acceptance red instead.
			if (
				attempt.exitCode === 0 ||
				(attempt.usage.turns > 0 && attempt.usage.noProgressTail === 0 && !attempt.usage.lastError)
			)
				break;
			const isLast = candidate === attemptModels[attemptModels.length - 1];
			if (!isLast) {
				appendAction(
					delegationId,
					`! ${candidate} produced no work (exit ${attempt.exitCode}) — retrying down-chain`,
				);
			}
		}
		const finalResult: SpawnResult = result ?? {
			exitCode: 1,
			finalText: "",
			stderr: "no chain model attempted",
			sessionId: null,
			usage: {
				input: 0,
				output: 0,
				turns: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				noProgressTail: 0,
			},
			seenToolCalls: new Set(),
			seenToolResults: new Set(),
		};
		const noProgressTail = finalResult.usage.noProgressTail;
		const lastError = finalResult.usage.lastError;
		const stopped = delegationStopRequested(delegationId);
		// Engine-signaled model errors are the primary failure signal: an error
		// event, a stopReason:"error" turn, or an exhausted auto-retry. The
		// no-progress tail is the defensive net for dead connections the engine
		// never signals. Either one fails the run even on a clean exit — the
		// partial text below is still delivered, it may hold useful work — but
		// the run must render red, never green.
		const ok = !stopped && finalResult.exitCode === 0 && !lastError && noProgressTail === 0;
		const text = stopped
			? finalResult.finalText
				? `${finalResult.finalText}\n\n(interrupted — stopped from the fleet view; partial output above)`
				: "(interrupted — stopped from the fleet view before any model output)"
			: finalResult.finalText ||
				`(no text output; exit=${finalResult.exitCode})\n${finalResult.stderr.slice(0, 2000)}`;
		await finishDelegation(delegationId, ok, text, finalResult.sessionId);
		if (emitResult) {
			emitTorusCustom(
				{
					customType: "torus.delegation-result",
					content: [
						{
							type: "text",
							text: `${agent.name} ${stopped ? "stopped" : ok ? "finished" : "failed"}`,
						},
					],
					display: true,
					details: {
						agent: agent.name,
						ok,
						delegationId,
						sessionId: finalResult.sessionId,
						handle,
						durationMs: Date.now() - startedAt,
						turns: finalResult.usage.turns,
						...(stopped ? { stopped: true } : {}),
						...(lastError ? { error: lastError } : {}),
						...(noProgressTail > 0 ? { noProgressTail } : {}),
					},
				},
				{ triggerTurn: false },
			);
		}
		return {
			ok,
			text,
			delegationId,
			details: {
				agent: agent.name,
				model: usedModel,
				exitCode: finalResult.exitCode,
				sessionId: finalResult.sessionId,
				delegationId,
				turns: finalResult.usage.turns,
				usage: finalResult.usage,
				noProgressTail,
				...(stopped ? { stopped: true } : {}),
				...(lastError ? { error: lastError } : {}),
				...(noProgressTail > 0
					? {
							noProgress: `delegated run ended without model progress (${noProgressTail} turn(s) with no progress — connection or model failure)`,
						}
					: {}),
			},
		};
	} catch (runError) {
		// Crash path: the success branch above leaves a result marker in the
		// transcript, so a rethrow must not strand a start marker with no
		// failure marker. finishDelegation is best-effort — an unwritable log
		// must not suppress the marker or mask the original error.
		try {
			await finishDelegation(delegationId, false, `delegation crashed: ${String(runError)}`);
		} catch {
			// registry finish failed (e.g. log unwritable); the marker below still goes out
		}
		if (emitResult) {
			emitTorusCustom(
				{
					customType: "torus.delegation-result",
					content: [{ type: "text", text: `${agent.name} failed` }],
					display: true,
					details: {
						agent: agent.name,
						ok: false,
						delegationId,
						handle,
						durationMs: Date.now() - startedAt,
						error: String(runError),
					},
				},
				{ triggerTurn: false },
			);
		}
		throw runError;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

const rosterTool = defineTool({
	name: "torus_roster",
	label: "Torus Roster",
	description:
		"List torus agents, their model fallback chains, which providers currently have credentials, and per-model concurrency caps (max parallel runs)",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text", text: rosterText() }],
			details: { agents: DELEGATABLE.length },
		};
	},
});

const delegateTool = defineTool({
	name: "torus_delegate",
	label: "Torus Delegate",
	description:
		"Delegate a single self-contained task to a torus agent (spawned engine subagent, JSON mode). Task text must carry all context the agent needs.",
	parameters: Type.Object({
		agent: Type.String({ description: `Agent name: ${DELEGATABLE.map((a) => a.name).join(", ")}` }),
		task: Type.String({ description: "Full task text, including any required context" }),
		handle: Type.Optional(
			Type.String({
				description:
					"Short @handle nickname for this run, shown in fleet views, tmux pane title, and statusline (e.g. scout)",
			}),
		),
		skills: Type.Optional(
			Type.Array(
				Type.String({
					description:
						"Skill name from pi's discovered skills (.pi/skills, ~/.pi/agent/skills, torus package pi.skills) or .agents/skills, or a file/directory path under one of those skill roots",
				}),
				{
					maxItems: 8,
				},
			),
		),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the subagent (default: current)" }),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Model for this run: 'primary' or 'fast' (chain shorthands) or an exact id like zai/glm-5.3 — starts the chain walk there, falls back down the agent's chain on no-work failures",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Return immediately instead of blocking: the result arrives later as a torus.delegation-result wake marker (batched with other pending wakes when busy); read the full output with torus_results",
			}),
		),
	}),
	// Machine-readable shape of successful results (codemode scripts receive
	// this instead of the text content). Every field optional; failures and
	// pre-flight rejections set no structuredContent.
	outputSchema: Type.Object({
		ok: Type.Optional(Type.Boolean()),
		text: Type.Optional(Type.String()),
		delegationId: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		turns: Type.Optional(Type.Number()),
		background: Type.Optional(Type.Boolean()),
		usage: Type.Optional(
			Type.Object({
				input: Type.Optional(Type.Number()),
				output: Type.Optional(Type.Number()),
				cacheRead: Type.Optional(Type.Number()),
				cacheWrite: Type.Optional(Type.Number()),
				cost: Type.Optional(Type.Number()),
			}),
		),
	}),
	renderCall(args, theme) {
		const handle = args.handle?.trim().replace(/^@+/, "");
		const skillsBadge = args.skills?.length
			? theme.fg("dim", ` [+${args.skills.length} skill${args.skills.length > 1 ? "s" : ""}]`)
			: "";
		return clickable(
			[
				new Text(
					theme.fg("toolTitle", theme.bold("delegate ")) +
						(handle ? theme.fg("accent", `@${handle} `) : "") +
						theme.fg("accent", args.agent) +
						skillsBadge +
						theme.fg("dim", ` "${flattenPreview(args.task, 60)}"`),
					0,
					0,
				),
			],
			// No delegation id exists at call time — click opens the fleet list.
			undefined,
		);
	},
	renderResult(result, { expanded, isPartial }, theme, context) {
		const details = (result.details ?? {}) as Record<string, unknown>;
		const agent = typeof details["agent"] === "string" ? details["agent"] : "?";
		const model = typeof details["model"] === "string" ? shortModel(details["model"]) : "?";
		const usage = (details["usage"] ?? {}) as Record<string, unknown>;
		const delegationId =
			typeof details["delegationId"] === "string" ? details["delegationId"] : undefined;
		const turns =
			typeof details["turns"] === "number"
				? details["turns"]
				: typeof usage["turns"] === "number"
					? usage["turns"]
					: undefined;

		if (isPartial) {
			const streaming = result.content.some(
				(block) => block.type === "text" && block.text.trim().length > 0,
			);
			const state = streaming ? `working · turn ${turns ?? 1}` : "starting";
			return clickable(
				[new Text(theme.fg("warning", `delegate ${agent} (${model}): ${state}`), 0, 0)],
				delegationId,
			);
		}

		const exitCode = typeof details["exitCode"] === "number" ? details["exitCode"] : 0;
		const inTok = typeof usage["input"] === "number" ? usage["input"] : 0;
		const outTok = typeof usage["output"] === "number" ? usage["output"] : 0;
		const cost = formatCost(
			typeof usage["cost"] === "number" ? usage["cost"] : undefined,
			inTok + outTok > 0,
		);
		const status =
			context?.isError === true || exitCode !== 0
				? theme.fg("error", exitCode !== 0 ? `exit ${exitCode}` : "failed")
				: theme.fg("success", "done");
		const headline =
			theme.fg("toolTitle", theme.bold("delegate ")) +
			theme.fg("accent", agent) +
			theme.fg(
				"dim",
				` (${model}) · ${status} · ${turns ?? "?"} turns · ${inTok}/${outTok} tok${cost ? ` · ${cost}` : ""}`,
			);

		if (!expanded) return clickable([new Text(headline, 0, 0)], delegationId);
		const body = result.content
			.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.slice(0, 2000);
		return clickable([new Text(`${headline}\n${theme.fg("dim", body)}`, 0, 0)], delegationId);
	},
	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		const handle = params.handle?.trim().replace(/^@+/, "") ?? null;
		const label = handle ? `@${handle}` : params.agent;
		// Live start signal: a transcript marker cannot render until this tool
		// call returns (engine defers mid-turn custom messages), so the chip and
		// onUpdate lead. The key gains the delegation id on first snapshot so
		// concurrent same-agent runs never share a statusline entry.
		const baseStatusKey = `torus:${handle ?? params.agent}`;
		let statusKey = baseStatusKey;
		ctx.ui.setStatus(statusKey, `▶ ${label} · starting`);
		if (onUpdate) {
			onUpdate({ content: [{ type: "text", text: `▶ ${label} · running` }], details: {} });
		}
		const capWarning = concurrencyWarning([plannedRunModel(params.agent, params.model)]);
		let backgroundNote = "";
		if (params.background === true) {
			if (
				!knobBoolean(
					"TORUS_DELEGATE_BACKGROUND",
					"roster",
					"delegateBackground",
					true,
					parseZeroDisables,
				)
			) {
				backgroundNote =
					"(background requested but disabled via TORUS_DELEGATE_BACKGROUND=0 — ran blocking)\n\n";
			} else {
				fireDelegationsBackground([
					{
						agent: params.agent,
						handle,
						start: () =>
							runDelegation(
								params.agent,
								params.task,
								params.cwd,
								undefined,
								ctx.sessionManager.getSessionId(),
								handle,
								params.skills ?? null,
								false,
								false,
								{ model: params.model ?? null },
							),
					},
				]);
				// One settle so startDelegation's registry record exists for the id
				// echo; the run itself is fire-and-forget.
				await sleep(100);
				const record = handle ? listDelegations().find((r) => r.handle === handle) : undefined;
				ctx.ui.setStatus(statusKey, undefined);
				return {
					content: [
						{
							type: "text",
							text: withWarning(
								`background delegation started — ${label} (${params.agent})${record ? ` · id ${record.id}` : ""}. Completion arrives as a torus.delegation-result marker (batched with other pending wakes when busy); read the full output with torus_results.`,
								capWarning,
							),
						},
					],
					details: {
						background: true,
						agent: params.agent,
						handle,
						...(record ? { delegationId: record.id } : {}),
					},
					structuredContent: {
						background: true,
						ok: true,
						...(record ? { delegationId: record.id } : {}),
					},
				};
			}
		}
		let outcome: DelegationOutcome;
		try {
			outcome = await runDelegation(
				params.agent,
				params.task,
				params.cwd,
				(snapshot) => {
					if (snapshot.delegationId) {
						const keyed = `${baseStatusKey}:${snapshot.delegationId.slice(0, 8)}`;
						if (keyed !== statusKey) {
							ctx.ui.setStatus(statusKey, undefined);
							statusKey = keyed;
						}
					}
					ctx.ui.setStatus(
						statusKey,
						`▶ ${label} · turn ${snapshot.turns} · ${snapshot.usage.output} tok`,
					);
					if (!onUpdate) return;
					const preview =
						snapshot.text.length > 1500 ? `${snapshot.text.slice(0, 1500)}...` : snapshot.text;
					onUpdate({
						content: [{ type: "text", text: preview || "(working...)" }],
						details: {
							agent: params.agent,
							delegationId: snapshot.delegationId,
							turns: snapshot.turns,
							usage: snapshot.usage,
						},
					});
				},
				ctx.sessionManager.getSessionId(),
				handle,
				params.skills ?? null,
				// No start marker: it defers until this call returns and would land
				// as a duplicate of the call line above. The tool block is the surface.
				false,
				undefined,
				{ model: params.model ?? null },
			);
		} finally {
			ctx.ui.setStatus(statusKey, undefined);
		}
		if (!outcome.ok) {
			// Exit-code failures render red through details.exitCode; engine-signaled
			// model errors and dead tails fail with exit 0, so isError is what flips
			// their tool block red while the text keeps the partial work.
			const failedCleanExit = outcome.details.exitCode === 0;
			return {
				content: [{ type: "text", text: withWarning(backgroundNote + outcome.text, capWarning) }],
				details: outcome.details,
				...(failedCleanExit ? { isError: true } : {}),
			};
		}
		const usage = (outcome.details.usage ?? {}) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" ? v : 0);
		return {
			content: [{ type: "text", text: withWarning(backgroundNote + outcome.text, capWarning) }],
			details: outcome.details,
			structuredContent: {
				ok: true,
				text: outcome.text,
				...(outcome.delegationId ? { delegationId: outcome.delegationId } : {}),
				...(typeof outcome.details.model === "string" ? { model: outcome.details.model } : {}),
				...(typeof outcome.details.turns === "number" ? { turns: outcome.details.turns } : {}),
				usage: {
					input: num(usage["input"]),
					output: num(usage["output"]),
					cacheRead: num(usage["cacheRead"]),
					cacheWrite: num(usage["cacheWrite"]),
					cost: num(usage["cost"]),
				},
			},
		};
	},
});

const RESULTS_LIST_CAP = 15;

/** Resolve an id to its record: exact match, else a unique prefix (the list renders 8-char id previews). */
function findRecordById(records: DelegationRecord[], id: string): DelegationRecord | undefined {
	const exact = records.find((r) => r.id === id);
	if (exact) return exact;
	const prefixed = records.filter((r) => r.id.startsWith(id));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

const resultsTool = defineTool({
	name: "torus_results",
	label: "Torus Results",
	description:
		"Read back delegation results (read-only): with id, one run's stored output — status, duration, turns, cost, log path, and the full text tail; without id, the most recent delegations",
	parameters: Type.Object({
		id: Type.Optional(
			Type.String({
				description:
					"Delegation id from a torus_delegate/torus_fanout/torus_chain echo or wake marker (exact id or a unique prefix); omit to list recent runs",
			}),
		),
	}),
	// Machine-readable shape of the single-record path; list and unknown-id
	// results set no structuredContent (same contract as torus_delegate).
	outputSchema: Type.Object({
		id: Type.Optional(Type.String()),
		status: Type.Optional(Type.String()),
		agent: Type.Optional(Type.String()),
		handle: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		turns: Type.Optional(Type.Number()),
		cost: Type.Optional(Type.Number()),
		logFile: Type.Optional(Type.String()),
		durationMs: Type.Optional(Type.Number()),
	}),
	async execute(_toolCallId, params) {
		const records = listDelegations();
		if (params.id === undefined) {
			if (records.length === 0) {
				return { content: [{ type: "text", text: "no delegation records yet" }], details: {} };
			}
			const lines = records.slice(0, RESULTS_LIST_CAP).map((record) => {
				const who = record.handle ? `@${record.handle}` : record.agent;
				const age = formatDuration((record.finishedAt ?? Date.now()) - record.startedAt);
				return `${who} · ${record.agent} · ${record.status} · ${age} · ${record.id.slice(0, 8)}…`;
			});
			const listDetails: Record<string, unknown> = { listed: lines.length };
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: listDetails,
			};
		}
		const record = findRecordById(records, params.id);
		if (!record) {
			return {
				isError: true,
				content: [{ type: "text", text: `no delegation record with id ${params.id}` }],
				details: {},
			};
		}
		// The registry keeps only a bounded head of the final text; the complete
		// text is read back from the delegation log. The in-memory copy wins when
		// it is known complete (live runs, short finals); when only the capped
		// slice survives, its loss is called out instead of ending mid-report.
		const text =
			record.status === "running" || record.textTruncated === false
				? record.text
				: (readFullRecordText(record) ??
					(record.textTruncated
						? `${record.text}\n\n[torus] stored text truncated at ${RECORD_TEXT_CAP} chars; the rest lives only in the log above`
						: record.text));
		const durationMs = (record.finishedAt ?? Date.now()) - record.startedAt;
		const cost = formatCost(record.cost, record.tokensIn + record.tokensOut > 0);
		const header = [
			`status: ${record.status}`,
			`agent: ${record.agent}`,
			`handle: ${record.handle ? `@${record.handle}` : "(none)"}`,
			`duration: ${formatDuration(durationMs)}`,
			`turns: ${record.turns}`,
			`cost: ${cost || "(none)"}`,
			`log: ${record.logFile}`,
		].join("\n");
		const recordDetails: Record<string, unknown> = { delegationId: record.id };
		return {
			content: [{ type: "text", text: `${header}\n\ntext:\n${text || "(no text stored)"}` }],
			details: recordDetails,
			structuredContent: {
				id: record.id,
				status: record.status,
				agent: record.agent,
				handle: record.handle ?? "",
				text,
				turns: record.turns,
				cost: record.cost,
				logFile: record.logFile,
				durationMs,
			},
		};
	},
});

export function registerRoster(pi: ExtensionAPI): void {
	pi.registerTool(rosterTool);
	pi.registerTool(delegateTool);
	pi.registerTool(resultsTool);

	setCustomSender((message, options) => {
		pi.sendMessage({ ...message, display: message.display ?? true }, options);
	});

	// Wake-gate wiring: run boundaries decide whether wake markers are held
	// (mid-run) or flushed straight through (idle). Between a settle and the
	// next start the session is idle, so a flush's triggerTurn marker starts
	// its own run and lands in one turn.
	pi.on("agent_start", () => wakeGateAgentStart());
	pi.on("agent_settled", () => wakeGateAgentSettled());

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		setCurrentSession(sessionId);
		rehydrateFromLogs(sessionId);
	});

	pi.on("session_shutdown", () => {
		void registryShutdown();
	});

	pi.registerCommand("roster", {
		description: "Show torus agents, chains, and credentialed providers",
		handler: async (_args, ctx) => {
			ctx.ui.notify(rosterText(), "info");
		},
	});

	for (const agent of AGENTS) {
		const commandNames = [agent.name, ...(agent.commandAliases ?? [])];
		for (const commandName of commandNames) {
			if (agent.mode === "session") {
				pi.registerCommand(commandName, {
					description: `Toggle the ${agent.name} persona for this session (${agent.description}); /${commandName} off clears it`,
					handler: async (args, ctx) => {
						if (args.trim() === "off") {
							setSessionPersona(null);
							ctx.ui.notify(`${agent.name} persona off`, "info");
							return;
						}
						setSessionPersona(agent.name);
						ctx.ui.notify(
							`${agent.name} persona active — orchestrator system prompt applied (delegation via torus_delegate/fanout/chain; /${commandName} off to clear)`,
							"info",
						);
					},
				});
				continue;
			}
			pi.registerCommand(commandName, {
				description: `Delegate to ${agent.name}: ${agent.description}`,
				handler: async (args, ctx) => {
					const task = args.trim();
					if (!task) {
						ctx.ui.notify(`Usage: /${commandName} <task text>`, "error");
						return;
					}
					const parentSession = ctx.sessionManager.getSessionId();
					const outcome = await runDelegation(
						agent.name,
						task,
						undefined,
						undefined,
						parentSession,
					);
					// Wait only on the delegation this command started, matched by id —
					// a concurrent model-driven fanout in the same session no longer
					// holds this command's follow-up hostage.
					const quiesceDeadline = Date.now() + QUIESCE_TIMEOUT_MS;
					while (
						outcome.delegationId !== null &&
						listDelegations().some(
							(r) => r.status === "running" && r.id === outcome.delegationId,
						) &&
						Date.now() < quiesceDeadline
					) {
						await sleep(QUIESCE_POLL_MS);
					}
					const summary =
						outcome.text.length > 4000 ? `${outcome.text.slice(0, 4000)}…` : outcome.text;
					pi.sendUserMessage(
						`[torus] ${agent.name} delegation ${outcome.ok ? "finished" : "FAILED"}. Full result:\n\n${summary}\n\nRead the result above and continue the session work if this outcome affects it.`,
						{ deliverAs: "followUp" },
					);
				},
			});
		}
	}
}

export default function rosterExtension(pi: ExtensionAPI): void {
	if (!gateExtension("roster", PLATFORM_SUPPORT)) return;
	registerRoster(pi);
}
