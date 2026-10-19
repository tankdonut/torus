/**
 * torus — sandbox ssh signing relay.
 *
 * Sandboxed git cannot ssh-sign commits: seccomp blocks the ssh-agent socket
 * (a path-scoped allow is an unmerged srt PR). But git's ssh signing shells
 * out to gpg.ssh.program with ssh-keygen-style argv — stdin/stdout + file
 * contracts per git's Documentation — so an executable wrapper installed as
 * gpg.ssh.program can relay the buffer to a host-side watcher that signs with
 * the real agent or key. Key material never enters the sandbox.
 *
 * SECURITY (threat model — keep): this relay is a signing ORACLE exposed to
 * sandboxed code. Anything inside the sandbox that can write a `*.req.json`
 * (through the wrapper or directly) can request a signature of arbitrary
 * bytes with any key the watcher can resolve on the host — equivalent
 * exposure to a forwarded ssh-agent socket. Enabling it must therefore be a
 * deliberate, informed opt-in (the enablement policy is wired elsewhere;
 * this module only takes options). Mitigations: the scratch dir is supplied
 * pre-created and private to the host session, key material never crosses
 * the boundary (payloads go out, signatures come back), there is no network,
 * no subprocess beyond ssh-keygen, and the watcher writes nothing outside the
 * scratch dir. Note that keyRef is resolved on the HOST (with `~` expansion):
 * a sandboxed caller names a host path, so the wiring layer must constrain
 * which keys may be referenced before opting in.
 *
 * Agent mode: OpenSSH's `ssh-keygen -Y sign -f <pubkey> -U` asks the agent
 * (via inherited SSH_AUTH_SOCK) to sign. git appends `-U` when
 * user.signingKey is a public key; the wrapper records the raw argv and the
 * watcher forwards `-U`. Whether a bare public key can sign depends on the
 * installed OpenSSH and agent state; tests use a real private key so no
 * agent is needed.
 *
 * Layout under scratchDir: `wrapper.mjs` (executable, git-facing program),
 * `requests/` (sandbox → host `*.req.json`), `responses/` (host → sandbox
 * `<id>.resp.json`), `hosttmp/` (payload staging, wiped by stop()). Both
 * sides write JSON via temp-file + rename so a reader never sees a partial
 * file. Processed requests are unlinked; the wrapper unlinks the response it
 * consumed — stale files from crashed runs are harmless and simply persist.
 */
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SignRelayOptions {
	/** Pre-created private dir; all relay state (watcher side) lives under it. */
	scratchDir: string;
	/** Real ssh-keygen to invoke on the host (default: PATH lookup). */
	sshKeygenPath?: string;
	/** Watcher poll interval for requests/ (default 100ms). */
	pollMs?: number;
	/** Per-request budget: wrapper wait and ssh-keygen kill timeout (default 30000ms). */
	requestTimeoutMs?: number;
	/** Watcher-error sink (default console.error); watcher errors never throw. */
	logSink?: (message: string) => void;
}

export interface SignRelay {
	/** Create dirs, write the wrapper fresh, begin polling. Idempotent. */
	start(): Promise<void>;
	/** Halt polling, finish in-flight requests, wipe hosttmp, mark stopped. Idempotent. */
	stop(): Promise<void>;
	/** Executable wrapper to install as gpg.ssh.program. */
	wrapperScriptPath: string;
	/** Drop dir sandboxed callers write `*.req.json` requests into. */
	requestsDir: string;
}

interface RelayRequest {
	argv: string[];
	fileContentB64: string;
	namespace: string;
	keyRef: string;
}

interface SignRelayResponse {
	id: string;
	ok: boolean;
	signatureB64?: string;
	error?: string;
}

interface KeygenResult {
	status: number | null;
	failure?: string;
	stdout: string;
	stderr: string;
}

const REQUESTS_DIR_NAME = "requests";
const RESPONSES_DIR_NAME = "responses";
const HOSTTMP_DIR_NAME = "hosttmp";
const WRAPPER_FILE_NAME = "wrapper.mjs";
const STOPPED_MARKER_NAME = "stopped";
const REQUEST_SUFFIX = ".req.json";
const RESPONSE_SUFFIX = ".resp.json";
const DEFAULT_POLL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_EXCERPT_MAX_CHARS = 500;
const WRAPPER_SCRATCH_PLACEHOLDER = "__TORUS_SIGN_RELAY_SCRATCH_DIR__";

/**
 * Start a host-side signing relay: writes the wrapper, prepares the
 * request/response dirs, and begins polling. Returns the started relay.
 */
export async function startSignRelay(options: SignRelayOptions): Promise<SignRelay> {
	const relay = new HostSignRelay(options);
	await relay.start();
	return relay;
}

class HostSignRelay implements SignRelay {
	readonly wrapperScriptPath: string;
	readonly requestsDir: string;

	private readonly scratchDir: string;
	private readonly responsesDir: string;
	private readonly hosttmpDir: string;
	private readonly stoppedMarkerPath: string;
	private readonly sshKeygenPath: string;
	private readonly pollMs: number;
	private readonly requestTimeoutMs: number;
	private readonly log: (message: string) => void;
	private timer: NodeJS.Timeout | null = null;
	private stopped = true;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: SignRelayOptions) {
		if (typeof options.scratchDir !== "string" || options.scratchDir.trim().length === 0) {
			throw new Error("sign relay: scratchDir must be a non-empty path");
		}
		this.scratchDir = path.resolve(options.scratchDir);
		this.requestsDir = path.join(this.scratchDir, REQUESTS_DIR_NAME);
		this.responsesDir = path.join(this.scratchDir, RESPONSES_DIR_NAME);
		this.hosttmpDir = path.join(this.scratchDir, HOSTTMP_DIR_NAME);
		this.wrapperScriptPath = path.join(this.scratchDir, WRAPPER_FILE_NAME);
		this.stoppedMarkerPath = path.join(this.scratchDir, STOPPED_MARKER_NAME);
		this.sshKeygenPath = options.sshKeygenPath ?? "ssh-keygen";
		this.pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
		this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		this.log = options.logSink ?? console.error;
	}

	async start(): Promise<void> {
		if (this.timer !== null) return;
		mkdirSync(this.requestsDir, { recursive: true });
		mkdirSync(this.responsesDir, { recursive: true });
		mkdirSync(this.hosttmpDir, { recursive: true });
		rmSync(this.stoppedMarkerPath, { force: true });
		const wrapperSource = buildWrapperSource(this.requestTimeoutMs).replace(
			WRAPPER_SCRATCH_PLACEHOLDER,
			JSON.stringify(this.scratchDir),
		);
		writeFileSync(this.wrapperScriptPath, wrapperSource);
		chmodSync(this.wrapperScriptPath, 0o755);
		this.stopped = false;
		this.timer = setInterval(() => this.scheduleTick(), this.pollMs);
		this.scheduleTick();
	}

	async stop(): Promise<void> {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.stopped = true;
		// Let an in-flight request finish so its wrapper is not left hanging.
		await this.queue;
		rmSync(this.hosttmpDir, { recursive: true, force: true });
		// Fail-fast marker: wrappers invoked after stop() exit immediately
		// instead of polling until their timeout. Cleared by the next start().
		if (existsSync(this.scratchDir)) {
			writeFileSync(this.stoppedMarkerPath, "");
		}
	}

	private scheduleTick(): void {
		this.queue = this.queue
			.then(() => this.processPendingRequests())
			.catch((error: unknown) => {
				// Watcher errors must never take the host process down.
				this.log(`torus sign relay: watcher error: ${formatError(error)}`);
			});
	}

	private async processPendingRequests(): Promise<void> {
		if (this.stopped || this.timer === null) return;
		for (const name of readdirSync(this.requestsDir)) {
			if (this.stopped) return;
			if (!name.endsWith(REQUEST_SUFFIX)) continue;
			await this.processRequest(path.join(this.requestsDir, name));
		}
	}

	private async processRequest(requestPath: string): Promise<void> {
		const id = path.basename(requestPath).slice(0, -REQUEST_SUFFIX.length);
		let raw: string;
		try {
			raw = readFileSync(requestPath, "utf8");
		} catch (error: unknown) {
			this.writeResponse(id, { id, ok: false, error: `unreadable request: ${formatError(error)}` });
			this.removeRequest(requestPath);
			return;
		}
		const parsed = parseRelayRequest(raw);
		if ("error" in parsed) {
			this.writeResponse(id, { id, ok: false, error: parsed.error });
			this.removeRequest(requestPath);
			return;
		}
		const request = parsed.request;
		const payloadPath = path.join(this.hosttmpDir, `${id}.payload`);
		const signaturePath = `${payloadPath}.sig`;
		try {
			writeFileSync(payloadPath, Buffer.from(request.fileContentB64, "base64"));
			const keyPath = resolveKeyRef(request.keyRef);
			const args = ["-Y", "sign", "-n", request.namespace, "-f", keyPath];
			if (request.argv.includes("-U")) args.push("-U");
			args.push(payloadPath);
			const result = await runSshKeygen(this.sshKeygenPath, args, this.requestTimeoutMs);
			if (result.status === 0 && existsSync(signaturePath)) {
				this.writeResponse(id, {
					id,
					ok: true,
					signatureB64: readFileSync(signaturePath).toString("base64"),
				});
			} else {
				this.writeResponse(id, { id, ok: false, error: describeKeygenFailure(result) });
			}
		} catch (error: unknown) {
			this.writeResponse(id, {
				id,
				ok: false,
				error: `request handling failed: ${formatError(error)}`,
			});
		} finally {
			rmSync(payloadPath, { force: true });
			rmSync(signaturePath, { force: true });
			this.removeRequest(requestPath);
		}
	}

	private writeResponse(id: string, response: SignRelayResponse): void {
		const responsePath = path.join(this.responsesDir, `${id}${RESPONSE_SUFFIX}`);
		const tempPath = `${responsePath}.tmp`;
		writeFileSync(tempPath, JSON.stringify(response));
		renameSync(tempPath, responsePath);
	}

	private removeRequest(requestPath: string): void {
		try {
			unlinkSync(requestPath);
		} catch (error: unknown) {
			this.log(
				`torus sign relay: could not remove processed request ${requestPath}: ${formatError(error)}`,
			);
		}
	}
}

function parseRelayRequest(raw: string): { request: RelayRequest } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: "malformed request: not valid JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "malformed request: expected a JSON object" };
	}
	const fields = parsed as Record<string, unknown>;
	if (typeof fields["namespace"] !== "string" || fields["namespace"].length === 0) {
		return { error: "malformed request: namespace must be a non-empty string" };
	}
	if (typeof fields["keyRef"] !== "string" || fields["keyRef"].length === 0) {
		return { error: "malformed request: keyRef must be a non-empty string" };
	}
	if (typeof fields["fileContentB64"] !== "string") {
		return { error: "malformed request: fileContentB64 must be a base64 string" };
	}
	const argv = fields["argv"];
	if (
		argv !== undefined &&
		(!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string"))
	) {
		return { error: "malformed request: argv must be an array of strings" };
	}
	return {
		request: {
			argv: Array.isArray(argv) ? argv : [],
			fileContentB64: fields["fileContentB64"] as string,
			namespace: fields["namespace"] as string,
			keyRef: fields["keyRef"] as string,
		},
	};
}

/**
 * keyRef arrives as the -f value the sandbox saw; resolve it on the HOST.
 * "~" and "~/" expand to the host home directory; anything else resolves
 * as-is (a host absolute path is expected).
 */
function resolveKeyRef(keyRef: string): string {
	if (keyRef === "~") return homedir();
	if (keyRef.startsWith("~/")) return path.join(homedir(), keyRef.slice(2));
	return path.resolve(keyRef);
}

function runSshKeygen(bin: string, args: string[], timeoutMs: number): Promise<KeygenResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (status: number | null, failure?: string): void => {
			if (settled) return;
			settled = true;
			resolve({ status, failure, stdout, stderr });
		};
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => finish(null, formatError(error)));
		child.on("close", (code: number | null) => finish(code));
	});
}

function describeKeygenFailure(result: KeygenResult): string {
	const detail = excerpt(result.stderr || result.stdout);
	const reason =
		result.failure ??
		(result.status === null ? "terminated (timeout or signal)" : `exit ${result.status}`);
	return `ssh-keygen failed (${reason})${detail.length > 0 ? `: ${detail}` : ""}`;
}

function excerpt(text: string): string {
	const cleaned = text.trim().replace(/\s+/g, " ");
	if (cleaned.length <= STDERR_EXCERPT_MAX_CHARS) return cleaned;
	return `${cleaned.slice(0, STDERR_EXCERPT_MAX_CHARS)}...`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The git-facing wrapper. Self-contained: the scratch dir is baked in via a
 * placeholder replacement at start() time (the script runs inside the
 * sandbox, where only the relay dirs are reachable). Emits the request,
 * polls for the response, and writes <file>.sig. Every failure path exits
 * nonzero — there is no silent unsigned fallback.
 */
function buildWrapperSource(requestTimeoutMs: number): string {
	return `#!/usr/bin/env node
// torus ssh sign relay wrapper — generated by extensions/sandbox/sign-relay.ts.
// git invokes gpg.ssh.program exactly like ssh-keygen:
//   <program> -Y sign -n <namespace> -f <key> <file>
// Instead of signing inside the sandbox (the agent socket is blocked and the
// key is not present anyway), this wrapper relays the payload to the
// host-side watcher and writes the returned signature to <file>.sig — the
// location ssh-keygen and git expect.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRATCH_DIR = __TORUS_SIGN_RELAY_SCRATCH_DIR__;
const REQUEST_TIMEOUT_MS = ${requestTimeoutMs};
const POLL_MS = 50;

function die(message) {
	process.stderr.write("torus sign relay: " + message + "\\n");
	process.exit(1);
}

function parseSignArgs(argv) {
	let namespace = null;
	let keyRef = null;
	let filePath = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-Y") {
			i += 1;
			if (argv[i] !== "sign") return { error: "unsupported invocation (only -Y sign)" };
		} else if (arg === "-n") {
			i += 1;
			namespace = argv[i] ?? null;
		} else if (arg === "-f") {
			i += 1;
			keyRef = argv[i] ?? null;
		} else if (arg === "-O") {
			i += 1; // signing options are not relayed
		} else if (arg === "-U") {
			// agent signing flag; recorded verbatim in the relayed argv
		} else if (filePath === null && !arg.startsWith("-")) {
			filePath = arg;
		} else {
			return { error: "unexpected argument: " + arg };
		}
	}
	if (namespace === null) return { error: "missing -n <namespace>" };
	if (keyRef === null) return { error: "missing -f <key>" };
	if (filePath === null) return { error: "missing <file> to sign" };
	return { namespace, keyRef, filePath };
}

const parsed = parseSignArgs(process.argv.slice(2));
if (parsed.error !== undefined) die(parsed.error);

const stoppedMarker = path.join(SCRATCH_DIR, "stopped");
if (existsSync(stoppedMarker)) die("relay is not running");

let payload;
try {
	payload = readFileSync(parsed.filePath);
} catch (error) {
	die("cannot read payload file " + parsed.filePath + ": " + error.message);
}

const id = randomUUID();
const request = {
	id: id,
	argv: process.argv.slice(2),
	fileContentB64: payload.toString("base64"),
	namespace: parsed.namespace,
	keyRef: parsed.keyRef,
};
const requestPath = path.join(SCRATCH_DIR, "requests", id + ".req.json");
writeFileSync(requestPath + ".tmp", JSON.stringify(request));
renameSync(requestPath + ".tmp", requestPath);

const responsePath = path.join(SCRATCH_DIR, "responses", id + ".resp.json");
const deadline = Date.now() + REQUEST_TIMEOUT_MS;
let response = null;
for (;;) {
	if (existsSync(responsePath)) {
		try {
			response = JSON.parse(readFileSync(responsePath, "utf8"));
		} catch {
			response = null; // partial reads cannot happen after atomic rename; retry anyway
		}
		if (response !== null) break;
	}
	if (existsSync(stoppedMarker)) die("relay stopped before responding");
	if (Date.now() >= deadline) die("timed out after " + REQUEST_TIMEOUT_MS + "ms waiting for the host signer");
	await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

if (response.ok !== true || typeof response.signatureB64 !== "string") {
	die(
		typeof response.error === "string" && response.error.length > 0
			? response.error
			: "host signer returned no signature",
	);
}

writeFileSync(parsed.filePath + ".sig", Buffer.from(response.signatureB64, "base64"));
try {
	unlinkSync(responsePath);
} catch {
	// best effort: a stale response is harmless
}
`;
}
