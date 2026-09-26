/**
 * `rpc-child.ts` — a live pi child that accepts follow-up turns over stdin.
 *
 * `executor.ts` runs `--mode json -p`: stdin closed, one prompt as argv, the
 * `agent_end` event is the run's end. That shape cannot answer "one more
 * question" — the child exits when its turn ends. This transport runs
 * `--mode rpc` instead: stdin stays open for `prompt`/`steer`/`follow_up`/
 * `abort` commands, and `agent_end` marks the *turn's* end, not the run's.
 *
 * The two transports share everything that made the JSON child correct:
 * `--no-session`, `agentChildEnv()` (the one-level fan-out flags travel in
 * env, exactly as before), the continuous stdout drain, the wall-clock kill,
 * and `finish()`'s outcome mapping. What differs is only how the run ends:
 * the caller ends it (`end`/`terminate`) or the deadline does — never the
 * child itself finishing a turn.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { killAgentTree } from "./process.ts";
import { resolvePiInvocation, type PiInvocation } from "./spawn.ts";
import {
	agentChildEnv,
	applyEvent,
	DEFAULT_AGENT_TIMEOUT_MS,
	emptyStreamState,
	readAgentActivity,
	readAgentProgress,
	type AgentActivity,
	type AgentProgress,
	type AgentRunResult,
} from "./executor.ts";

const STDIO_GRACE_MS = 200;
const TERMINATION_GRACE_MS = 1_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 512 * 1024;

/** RPC-mode args: a live stdin protocol, `-p` implied by mode, still no session store. */
export function rpcRunArgs(): string[] {
	return ["--mode", "rpc", "--no-session"];
}

/** Copied from executor.ts' `writeSystemPrompt` (package-internal there). */
async function writeSystemPromptFile(systemPrompt: string | undefined, root = tmpdir()): Promise<{ dir: string; file: string } | undefined> {
	if (!systemPrompt || !systemPrompt.trim()) return undefined;
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(root, "pi-rpc-agent-"));
		const file = join(dir, "system-prompt.md");
		await writeFile(file, systemPrompt, { encoding: "utf-8", mode: 0o600 });
		return { dir, file };
	} catch (error) {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`Could not prepare delegated system prompt: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export interface RpcChildInput {
	prompt: string;
	cwd: string;
	systemPrompt?: string;
	tools?: string[];
	model?: string;
	effort?: string;
	extensionPaths?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	evidencePath?: string;
	evidenceMaxBytes?: number;
	onActivity?: (activity: AgentActivity) => void;
	onProgress?: (event: AgentProgress) => void;
	/** Fires with `true` when a turn ends (lane is idle, awaiting a prompt) and `false` when a turn starts. */
	onIdleChange?: (idle: boolean) => void;
}

/** A live child handle: send commands, read the eventual run result, or end it. */
export interface RpcChild {
	readonly pid: number | undefined;
	/** Resolves with the run outcome when the child is finished — by `end`, `terminate`, deadline, abort, or exit. */
	readonly done: Promise<AgentRunResult>;
	/** Queue a stdin command. Returns false when stdin is already gone (dead or draining). */
	send(command: { type: "prompt" | "steer" | "follow_up" | "abort"; message?: string }): boolean;
	/** Graceful finish: terminate the child, resolve `done` with the normal outcome mapping. */
	end(): void;
	/** Hard stop: resolve `done` as an abort and kill the process. */
	terminate(): void;
}

export interface SpawnRpcChildOptions {
	invocation?: PiInvocation;
	extraArgs?: string[];
	systemPromptRoot?: string;
	/** Test seam: replace `spawn` without touching the real process table. */
	spawnFn?: typeof spawn;
}

/**
 * Spawn an RPC child and write the initial `prompt` command. The returned
 * handle stays useful across turns until `done` resolves.
 */
export async function spawnRpcChild(input: RpcChildInput, options: SpawnRpcChildOptions = {}): Promise<RpcChild> {
	const invocation = options.invocation ?? resolvePiInvocation();
	const systemPrompt = await writeSystemPromptFile(input.systemPrompt, options.systemPromptRoot);
	const spawnFn = options.spawnFn ?? spawn;
	try {
		const args = [
			...invocation.args,
			...rpcRunArgs(),
			...(options.extraArgs ?? []),
			...(input.extensionPaths ?? []).flatMap((path) => ["--extension", path]),
			...(input.tools && input.tools.length > 0 ? ["--tools", input.tools.join(",")] : []),
			...(input.model ? ["--model", input.model] : []),
			...(input.effort ? ["--thinking", input.effort] : []),
			...(systemPrompt ? ["--append-system-prompt", systemPrompt.file] : []),
		];
		const timeoutMs = input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
		const evidencePath = input.evidencePath;
		const evidenceMaxBytes = input.evidenceMaxBytes ?? MAX_EVIDENCE_BYTES;

		let resolveDone: (result: AgentRunResult) => void = () => {};
		const done = new Promise<AgentRunResult>((resolve) => { resolveDone = resolve; });

		const child = spawnFn(invocation.command, args, {
			cwd: input.cwd,
			// Rule 1 differs from the JSON child on purpose: stdin is the control
			// channel. Every write goes through `send` — never a free-floating pipe.
			stdio: ["pipe", "pipe", "pipe"],
			env: agentChildEnv(),
			detached: process.platform !== "win32",
			windowsHide: true,
		}) as ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>;

		const state = emptyStreamState();
		let buffer = "";
		let stderr = "";
		let settled = false;
		let killedBy: "timeout" | "abort" | undefined;
		let endRequested = false;
		let terminationRequested = false;
		let forceKilled = false;
		let stdinOpen = Boolean(child.stdin && !child.stdin.destroyed);
		let terminationTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let exitCode: number | null = null;
		let evidenceBytes = 0;
		let evidenceQueue: Promise<void> = evidencePath
			? mkdir(dirname(evidencePath), { recursive: true }).then(() => undefined, () => undefined)
			: Promise.resolve();

		const writeEvidence = (line: string): void => {
			if (!evidencePath) return;
			evidenceQueue = evidenceQueue.then(async () => {
				if (evidenceBytes >= evidenceMaxBytes) {
					if (evidenceBytes < evidenceMaxBytes + 1_000) {
						evidenceBytes += 1_000;
						await appendFile(evidencePath, JSON.stringify({ type: "evidence_truncated", bytes: evidenceMaxBytes }) + "\n").catch(() => undefined);
					}
					return;
				}
				const chunk = `${line}\n`;
				evidenceBytes += Buffer.byteLength(chunk);
				await appendFile(evidencePath, chunk).catch(() => undefined);
			});
		};

		const timer = setTimeout(() => {
			killedBy = "timeout";
			requestTerminate();
		}, timeoutMs);
		timer.unref?.();

		const onAbort = (): void => {
			killedBy = "abort";
			requestTerminate();
		};
		if (input.signal) {
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}

		function requestTerminate(): void {
			if (terminationRequested) return;
			terminationRequested = true;
			if (process.platform === "win32") {
				kill();
				boundDrain();
				return;
			}
			try { child.kill("SIGTERM"); } catch { /* Hard stop below is the fallback. */ }
			terminationTimer = setTimeout(() => {
				kill();
				boundDrain();
			}, TERMINATION_GRACE_MS);
		}

		function kill(): void {
			if (forceKilled) return;
			forceKilled = true;
			killAgentTree(child.pid ?? undefined);
		}

		function boundDrain(): void {
			if (!drainTimer && !settled) drainTimer = setTimeout(finish, STDIO_GRACE_MS);
		}

		function finish(): void {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (terminationTimer) clearTimeout(terminationTimer);
			if (drainTimer) clearTimeout(drainTimer);
			input.signal?.removeEventListener("abort", onAbort);
			kill();
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();

			if (state.errorMessage === undefined && stderr.trim()) state.errorMessage = stderr.trim().slice(0, 2_000);
			if (state.errorMessage === undefined && exitCode !== null && exitCode !== 0) {
				state.errorMessage = `The agent exited with code ${exitCode}.`;
			}

			let outcome: AgentRunResult;
			if (killedBy === "abort") {
				outcome = { status: "aborted", stopReason: "aborted", text: state.finalText, usage: state.usage };
			} else if (killedBy === "timeout") {
				outcome = {
					status: "failed",
					text: state.finalText,
					errorMessage: `The agent timed out after ${timeoutMs}ms${evidencePath ? `; its event stream is at ${evidencePath}` : ""}`,
					usage: state.usage,
				};
			} else if (state.errorMessage) {
				outcome = { status: "failed", errorMessage: state.errorMessage, text: state.finalText, usage: state.usage };
			} else {
				outcome = {
					status: "completed",
					text: state.finalText,
					usage: state.usage,
					...(state.model ? { model: state.model } : {}),
					...(state.stopReason ? { stopReason: state.stopReason } : {}),
				};
			}

			void evidenceQueue.then(() => resolveDone(outcome), () => resolveDone(outcome));
		}

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_BUFFER_CHARS) buffer = buffer.slice(-MAX_BUFFER_CHARS / 2);
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				writeEvidence(line.replace(/\r$/u, ""));
				const text = line.replace(/\r$/u, "").trim();
				if (!text) continue;
				try {
					const event = JSON.parse(text) as Record<string, unknown>;
					// `agent_end` is a turn boundary under RPC, not the run's end —
					// same for `agent_start`. applyEvent treats it as the run's end
					// in JSON mode, so feed it the accumulated-text branch only and
					// drive idle reporting off the raw type.
					if (event.type === "agent_start") input.onIdleChange?.(false);
					else if (event.type === "agent_end") input.onIdleChange?.(true);
					applyEvent(state, event);
					const activity = readAgentActivity(event);
					if (activity) {
						try { input.onActivity?.(activity); } catch { /* observers cannot fail a child run */ }
					}
					const progress = readAgentProgress(event);
					if (progress) {
						try { input.onProgress?.(progress); } catch { /* UI updates cannot fail the run */ }
					}
				} catch {
					// A non-JSON line (or an RPC `response`/`extension_*` ack) is
					// protocol noise the fold never needs.
				}
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
		});
		child.stdin?.on("error", () => { stdinOpen = false; });
		child.on("error", (error) => {
			state.errorMessage = error instanceof Error ? error.message : String(error);
			finish();
		});
		child.on("exit", (code) => {
			exitCode = code;
			if (timer) clearTimeout(timer);
			boundDrain();
		});
		child.on("close", (code) => {
			exitCode = code;
			finish();
		});

		const send = (command: { type: "prompt" | "steer" | "follow_up" | "abort"; message?: string }): boolean => {
			if (!stdinOpen || settled) return false;
			try {
				const ok = child.stdin.write(`${JSON.stringify({ id: randomUUID(), ...command })}\n`);
				if (!ok) child.stdin.once("drain", () => undefined);
				return true;
			} catch {
				stdinOpen = false;
				return false;
			}
		};

		const handle: RpcChild = {
			pid: child.pid ?? undefined,
			done,
			send,
			end() {
				if (settled || endRequested) return;
				endRequested = true;
				// Ask pi to stop its in-flight turn first; the process termination
				// follows on the same SIGTERM path a timeout uses.
				send({ type: "abort" });
				requestTerminate();
			},
			terminate() {
				if (settled) return;
				killedBy = "abort";
				requestTerminate();
			},
		};

		// The first turn starts as soon as the command lands; a write failure is
		// reported through `done` (the child will exit and `finish` maps it).
		send({ type: "prompt", message: input.prompt });
		return handle;
	} finally {
		if (systemPrompt) await rm(systemPrompt.dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
