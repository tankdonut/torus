/**
 * torus — agent roster, delegation tool, and per-agent commands.
 *
 * Delegation uses pi's canonical subagent pattern: spawn the engine itself in
 * JSON mode (`<engine> --mode json -p --no-session --model <m>`) and consume
 * the JSONL event stream on stdout.
 *
 * Three levers surface the roster:
 *   - torus_roster / torus_delegate tools (model-driven)
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
import {
	childExtensionArgs,
	type EngineTally,
	engineChildEnv,
	parseEngineEvent,
	reduceEngineEvent,
	resolveEngineBin,
	sessionIdFromState,
} from "../engine-child.js";
import { flattenPreview, shortModel } from "../fleet/theme-kit.js";
import { parseFrontmatter, stripFrontmatter } from "../frontmatter.js";
import { formatCost, sleep, splitList } from "../fsutil.js";
import { clickable } from "../notify/index.js";
import { type ChainTier, modelChain, providerAvailabilities } from "../providers/index.js";
import {
	AGENT_NAME_RE,
	appendAction,
	attachControl,
	attachSessionId,
	emitTorusCustom,
	finishDelegation,
	listDelegations,
	redactSecrets,
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
	return [providers, ...agents].join("\n");
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
			text: "No credentialed model in chain. Authenticate zai (/login zai) or set the opencode-go env.",
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
	startDelegation(delegationId, agent.name, firstModel, parentSession, handle);
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
		// Engine-signaled model errors are the primary failure signal: an error
		// event, a stopReason:"error" turn, or an exhausted auto-retry. The
		// no-progress tail is the defensive net for dead connections the engine
		// never signals. Either one fails the run even on a clean exit — the
		// partial text below is still delivered, it may hold useful work — but
		// the run must render red, never green.
		const ok = finalResult.exitCode === 0 && !lastError && noProgressTail === 0;
		const text =
			finalResult.finalText ||
			`(no text output; exit=${finalResult.exitCode})\n${finalResult.stderr.slice(0, 2000)}`;
		finishDelegation(delegationId, ok, text, finalResult.sessionId);
		if (emitResult) {
			emitTorusCustom(
				{
					customType: "torus.delegation-result",
					content: [
						{
							type: "text",
							text: `${agent.name} ${ok ? "finished" : "failed"}`,
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
			finishDelegation(delegationId, false, `delegation crashed: ${String(runError)}`);
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
		"List torus agents, their model fallback chains, and which providers currently have credentials",
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
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
				...(failedCleanExit ? { isError: true } : {}),
			};
		}
		const usage = (outcome.details.usage ?? {}) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" ? v : 0);
		return {
			content: [{ type: "text", text: outcome.text }],
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

export function registerRoster(pi: ExtensionAPI): void {
	pi.registerTool(rosterTool);
	pi.registerTool(delegateTool);

	setCustomSender((message, options) => {
		pi.sendMessage({ ...message, display: message.display ?? true }, options);
	});

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		setCurrentSession(sessionId);
		rehydrateFromLogs(sessionId);
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
	registerRoster(pi);
}
