import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { engineChildEnv } from "./engine-child.js";

const STDERR_CAP = 64 * 1024;
const LINE_CAP = 1024 * 1024;

interface RpcEvents {
	onEvent?: (event: Record<string, unknown>) => void;
	onSettled?: () => void;
}

interface Pending {
	resolve: (response: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Minimal pi RPC-mode client: newline-delimited JSON on stdin/stdout.
 * Commands carry an id; `{"type":"response","id":...}` records resolve the
 * pending promise. Every other record is a session event (same shapes as
 * JSON mode) routed to onEvent; agent_settled additionally fires onSettled.
 */
export class RpcChild {
	private proc: ChildProcess;
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	readonly exited: Promise<number>;
	stderrText = "";

	/** True while the child can still receive a steer: running, unkilled, stdin writable. */
	get steerable(): boolean {
		return this.proc.exitCode === null && !this.proc.killed && (this.proc.stdin?.writable ?? false);
	}

	/** Unparsed stdout bytes currently held — diagnostics and cap verification. */
	get buffered(): number {
		return this.buffer.length;
	}

	private readonly events: RpcEvents;
	private readonly stdoutDecoder = new StringDecoder("utf8");
	private readonly stderrDecoder = new StringDecoder("utf8");

	constructor(bin: string, args: string[], cwd: string, events: RpcEvents) {
		this.events = events;
		this.proc = spawn(bin, args, {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: engineChildEnv(),
		});
		this.exited = new Promise((resolve) => {
			this.proc.on("error", () => resolve(1));
			this.proc.on("close", (code) => resolve(code ?? 0));
		});
		const failPending = (reason: string): void => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error(reason));
			}
			this.pending.clear();
		};
		this.proc.stdin?.on("error", (error) => failPending(`rpc stdin error: ${String(error)}`));
		this.proc.on("error", (error) => failPending(`rpc child error: ${String(error)}`));
		this.proc.on("close", () => {
			this.buffer += this.stdoutDecoder.end();
			if (this.stderrText.length < STDERR_CAP) {
				this.stderrText += this.stderrDecoder.end().slice(0, STDERR_CAP - this.stderrText.length);
			}
			failPending("rpc child closed before responding");
		});
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += this.stdoutDecoder.write(chunk);
			// A line longer than LINE_CAP cannot be a valid RPC record; keep the
			// tail so a real response following runaway garbage still parses.
			if (this.buffer.length > LINE_CAP) this.buffer = this.buffer.slice(-LINE_CAP);
			let newline = this.buffer.indexOf("\n");
			while (newline !== -1) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				this.handleLine(line);
				newline = this.buffer.indexOf("\n");
			}
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			if (this.stderrText.length >= STDERR_CAP) return;
			const decoded = this.stderrDecoder.write(chunk);
			this.stderrText += decoded.slice(0, STDERR_CAP - this.stderrText.length);
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof event !== "object" || event === null) return;
		const record = event as Record<string, unknown>;
		if (record["type"] === "response" && typeof record["id"] === "string") {
			const pending = this.pending.get(record["id"]);
			if (pending) {
				this.pending.delete(record["id"]);
				clearTimeout(pending.timer);
				pending.resolve(record);
			}
			return;
		}
		if (record["type"] === "agent_settled") this.events.onSettled?.();
		this.events.onEvent?.(record);
	}

	send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `torus-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`rpc timeout awaiting ${String(command["type"])} response`));
			}, RESPONSE_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.proc.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	prompt(text: string): Promise<Record<string, unknown>> {
		return this.send({ type: "prompt", message: text });
	}

	steer(text: string): Promise<Record<string, unknown>> {
		return this.send({ type: "steer", message: text });
	}

	getState(): Promise<Record<string, unknown>> {
		return this.send({ type: "get_state" });
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		try {
			this.proc.kill(signal);
		} catch {
			// already dead
		}
	}
}
