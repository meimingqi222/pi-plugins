/**
 * `rpc-child.ts` — a live pi child that accepts follow-up turns over stdin.
 *
 * `executor.ts` runs `--mode json -p`: stdin closed, one prompt as argv, the
 * `agent_end` event is the run's end. That shape cannot answer "one more
 * question" — the child exits when its turn ends. This transport runs
 * `--mode rpc` instead: stdin stays open for `prompt`/`steer`/`follow_up`/
 * `abort` commands, and `agent_settled` marks a *turn's* end, not the run's
 * (`agent_end` only ends the model's stream; pi may still retry, compact, or
 * drain a queued prompt before the turn is really over).
 *
 * The two transports share everything that made the JSON child correct:
 * `--no-session`, `agentChildEnv()` (the one-level fan-out flags travel in
 * env, exactly as before), the continuous stdout drain, the wall-clock kill,
 * and `finish()`'s outcome mapping. What differs is only how the run ends:
 * the caller ends it (`end`/`terminate`) or the deadline does — never the
 * child itself finishing a turn.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { killAgentTree } from "./process.ts";
import {
	createEvidenceWriter,
	createJsonLineReader,
	mapRunOutcome,
	MAX_STDERR_CHARS,
	writeSystemPromptFile,
} from "./child-io.ts";
import { resolvePiInvocation, type PiInvocation } from "./spawn.ts";
import {
	agentChildEnv,
	applyEvent,
	DEFAULT_AGENT_TIMEOUT_MS,
	describeAgentEvent,
	emptyStreamState,
	readAgentActivity,
	readAgentProgress,
	resolveStallMs,
	stallCheckIntervalMs,
	stallFailureMessage,
	stallThresholdMs,
	STDIO_GRACE_MS,
	TERMINATION_GRACE_MS,
	timeoutFailureMessage,
	trackDeclaredTimeouts,
	type AgentActivity,
	type AgentProgress,
	type AgentRunResult,
} from "./executor.ts";

const MAX_EVIDENCE_BYTES = 512 * 1024;
/**
 * Extension UI methods that *wait* for a client answer.
 *
 * These four are the dialogs in the installed build
 * (`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`): each emits an
 * `extension_ui_request` and blocks until a matching `extension_ui_response`
 * arrives, or until its own `timeout` field expires.
 *
 * Everything else is either fire-and-forget (`notify`, `setStatus`, `setTitle`,
 * `setWidget`, `set_editor_text`) or degraded to an immediate value (`custom`
 * returns `undefined` without emitting anything), so none of it may be answered
 * — a response to a request with no pending entry is dropped by pi, but sending
 * one would still be a lie about the protocol.
 */
const EXTENSION_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** RPC-mode args: a live stdin protocol, `-p` implied by mode, still no session store. */
export function rpcRunArgs(): string[] {
	return ["--mode", "rpc", "--no-session"];
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
	/**
	 * How long a *turn* may emit nothing before the run is failed. Unset reads
	 * `PI_AGENT_STALL_MS`, then the shared default; `0` disables it.
	 *
	 * The bound is suspended between turns: an idle lane is waiting for its
	 * owner's reply, which is not the same failure as a wedged turn.
	 */
	stallMs?: number;
	evidencePath?: string;
	evidenceMaxBytes?: number;
	onActivity?: (activity: AgentActivity) => void;
	/** Raw parsed events for opt-in transcript observers; may contain tool data. */
	onEvent?: (event: unknown) => void;
	onProgress?: (event: AgentProgress) => void;
	/**
	 * Fires with `true` when a turn is fully settled (lane is idle, awaiting a
	 * prompt) and `false` when a turn starts. Turn end is `agent_settled`, not
	 * `agent_end`: pi can still retry, compact, or drain a queued prompt between
	 * the two, so the lane is not safe to prompt until `agent_settled`.
	 */
	onIdleChange?: (idle: boolean) => void;
	/**
	 * Fires once per `agent_settled` with that turn's outcome: `completed`,
	 * or `failed` when the turn's state carries an error. `usage` is cumulative
	 * across turns, not per-turn. The run itself stays open — `done` still
	 * resolves only when the child finishes.
	 */
	onTurnSettled?: (result: AgentRunResult) => void;
	/**
	 * Fires when pi answers a stdin command with `success: false` — e.g. a
	 * prompt pi refused. Without this the failure line is indistinguishable
	 * from the run's event stream and a rejected command looks sent.
	 */
	onCommandError?: (info: { command: string; error: string }) => void;
}

/** A live child handle: send commands, read the eventual run result, or end it. */
export interface RpcChild {
	readonly pid: number | undefined;
	/** Resolves with the run outcome when the child is finished — by `end`, `terminate`, deadline, abort, or exit. */
	readonly done: Promise<AgentRunResult>;
	/** Queue a stdin command. Returns false when stdin is already gone (dead or draining). */
	send(command: { type: "prompt" | "steer" | "follow_up" | "abort"; message?: string; streamingBehavior?: "steer" | "followUp" }): boolean;
	/** Graceful finish: terminate the child, resolve `done` with the normal outcome mapping. */
	end(): void;
	/** Hard stop: resolve `done` as an abort and kill the process. */
	terminate(): void;
}

export interface SpawnRpcChildOptions {
	invocation?: PiInvocation;
	extraArgs?: string[];
	systemPromptRoot?: string;
	/** Silence cap for one child when the input does not set one. */
	stallMs?: number;
	/**
	 * Test seam: the SIGTERM-to-SIGKILL escalation window, in milliseconds.
	 *
	 * Defaults to `TERMINATION_GRACE_MS`. A test that drives a kill path against a
	 * child which does not exit on SIGTERM waits this window out in full, so the
	 * unit tests shorten it while `process-tree.test.ts` measures the production
	 * value against real children.
	 */
	terminationGraceMs?: number;
	/**
	 * Test seam: the post-exit pipe drain cap, in milliseconds. Defaults to
	 * `STDIO_GRACE_MS`, for the same reason as `terminationGraceMs`.
	 */
	stdioGraceMs?: number;
	/** Test seam: replace `spawn` without touching the real process table. */
	spawnFn?: typeof spawn;
}

/**
 * Spawn an RPC child and write the initial `prompt` command. The returned
 * handle stays useful across turns until `done` resolves.
 */
export async function spawnRpcChild(input: RpcChildInput, options: SpawnRpcChildOptions = {}): Promise<RpcChild> {
	const invocation = options.invocation ?? resolvePiInvocation();
	const systemPrompt = await writeSystemPromptFile(input.systemPrompt, options.systemPromptRoot, "pi-rpc-agent-");
	async function cleanupSystemPrompt(): Promise<void> {
		if (systemPrompt) await rm(systemPrompt.dir, { recursive: true, force: true }).catch(() => undefined);
	}
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
		const terminationGraceMs = Math.max(0, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
		const stdioGraceMs = Math.max(0, options.stdioGraceMs ?? STDIO_GRACE_MS);
		let stderr = "";
		let settled = false;
		let killedBy: "timeout" | "abort" | "stalled" | undefined;
		/** How quiet the child was when the stall bound fired; only meaningful with `killedBy === "stalled"`. */
		let stalledForMs = 0;
		/** The liveness clock: any parsed event moves it. */
		let lastEventAt = Date.now();
		let lastEventLabel = "spawn";
		/** Declared budgets of the tool calls in flight, keyed by call id; see `trackDeclaredTimeouts`. */
		const declaredBudgets = new Map<string, number>();
		/** False between `agent_settled` and the next `agent_start`, when silence is expected. */
		let turnActive = true;
		let endRequested = false;
		let terminationRequested = false;
		let forceKilled = false;
		let stdinOpen = Boolean(child.stdin && !child.stdin.destroyed);
		let terminationTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let exitCode: number | null = null;
		const evidence = createEvidenceWriter({ path: evidencePath, maxBytes: evidenceMaxBytes });

		// The wall clock bounds a *turn*, not the whole child lifetime: an idle
		// lane awaiting a reply is bounded by the caller's keepalive, and counting
		// that idle time against the turn's budget would kill the next turn with
		// time it never spent. The first reason to end a run owns the label —
		// without the guard the wall clock relabels a run the silence bound (or a
		// caller's abort) already ended, because termination has a grace period
		// and the deadline can expire inside it.
		//
		// The armed turn timer is deliberately **not** unref'd, and neither is the
		// silence bound below. While a turn is in flight the turn's wall clock is
		// the only thing that can end a run whose caller is awaiting `done`, and a
		// timer the process is allowed to ignore cannot resolve that await: with
		// Bun the loop looks empty, so it neither fires the timer nor exits — it
		// spins at 100% CPU, which is how `test/rpc-child.test.ts` stopped
		// finishing on Windows. `clearTurnTimer()` (on `agent_settled` and on
		// `exit`) and `finish()` both clear it, so an idle lane and a settled run
		// hold nothing open. The unref'd timer in this plugin is the idle
		// keepalive in `plugins/subagent/src/index.ts`, because nobody awaits it.
		let turnTimer: ReturnType<typeof setTimeout> | undefined;
		const armTurnTimer = (): void => {
			if (turnTimer || settled) return;
			turnTimer = setTimeout(() => {
				turnTimer = undefined;
				if (settled || killedBy) return;
				killedBy = "timeout";
				requestTerminate();
			}, timeoutMs);
		};
		const clearTurnTimer = (): void => {
			if (turnTimer) { clearTimeout(turnTimer); turnTimer = undefined; }
		};

		// Silence inside a turn means the child is wedged, and the wall clock would
		// only discover that at the deadline, having spent the whole budget. An idle
		// lane is exempt: it has nothing to say until its owner replies.
		const stallMs = resolveStallMs(input.stallMs ?? options.stallMs);
		const stallTimer = stallMs > 0
			? setInterval(() => {
				if (settled || killedBy || !turnActive) return;
				const quiet = Date.now() - lastEventAt;
				if (quiet < stallThresholdMs(stallMs, declaredBudgets)) return;
				stalledForMs = quiet;
				killedBy = "stalled";
				requestTerminate();
			}, stallCheckIntervalMs(stallMs))
			: undefined;

		const onAbort = (): void => {
			if (!killedBy) killedBy = "abort";
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
			}, terminationGraceMs);
		}

		function kill(): void {
			if (forceKilled) return;
			forceKilled = true;
			killAgentTree(child.pid ?? undefined);
		}

		function boundDrain(): void {
			if (!drainTimer && !settled) drainTimer = setTimeout(finish, stdioGraceMs);
		}

		function finish(): void {
			if (settled) return;
			settled = true;
			clearTurnTimer();
			if (stallTimer) clearInterval(stallTimer);
			if (terminationTimer) clearTimeout(terminationTimer);
			if (drainTimer) clearTimeout(drainTimer);
			input.signal?.removeEventListener("abort", onAbort);
			kill();
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();

			const outcome = mapRunOutcome({
				killedBy,
				stalledForMs,
				lastEventLabel,
				timeoutMs,
				stderr,
				exitCode,
				state,
				...(evidencePath ? { evidencePath } : {}),
			});

			// The child reads this file during startup, after spawn returned. Keep
			// it until the run ends, and finish cleanup before exposing done.
			void Promise.all([evidence.flush(), cleanupSystemPrompt()])
				.then(() => resolveDone(outcome), () => resolveDone(outcome));
		}

		/**
		 * The single stdin write path, so the dialog responder and the control
		 * commands cannot disagree about framing or backpressure.
		 */
		/** Command ids in flight → their type, so a failed `response` can name what was refused. */
		const pendingCommands = new Map<string, string>();
		const write = (command: Record<string, unknown>): boolean => {
			if (!stdinOpen || settled) return false;
			try {
				const id = randomUUID();
				const ok = child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
				if (typeof command.type === "string") pendingCommands.set(id, command.type);
				if (!ok) child.stdin.once("drain", () => undefined);
				return true;
			} catch {
				stdinOpen = false;
				return false;
			}
		};

		const send = (command: { type: "prompt" | "steer" | "follow_up" | "abort"; message?: string; streamingBehavior?: "steer" | "followUp" }): boolean =>
			// A prompt always carries `followUp`: without it pi throws "Agent is
			// already processing" when the command lands inside the agent_end→
			// agent_settled window (retry, compaction, queued work) instead of
			// queueing it.
			write(command.type === "prompt" ? { streamingBehavior: "followUp", ...command } : command);

		/**
		 * Answer an extension dialog instead of letting the child wait forever.
		 *
		 * The JSON child is handed `noOpUIContext`, which resolves every dialog
		 * immediately (`confirm` → false, `select`/`input` → undefined). An RPC child
		 * is handed a real UI context whose dialogs emit `extension_ui_request` and
		 * then wait for `extension_ui_response` — with no timeout unless the caller
		 * passed one. Nothing else here answers them, so a single dialog would pin the
		 * child until the wall clock. Cancelling reproduces the no-op context exactly.
		 */
		const answerExtensionUi = (event: Record<string, unknown>): void => {
			const id = typeof event.id === "string" ? event.id : undefined;
			const method = typeof event.method === "string" ? event.method : undefined;
			if (!id || !method || !EXTENSION_DIALOG_METHODS.has(method)) return;
			write({ type: "extension_ui_response", id, cancelled: true });
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", createJsonLineReader((line, parsed) => {
			evidence.write(line);
			if (parsed === undefined) return;
			// A parsed line is either a stream event or a protocol ack (`response`,
			// `extension_*`); both are handled here, and the stream fold only
			// needs the event shapes it knows.
			try {
				const event = parsed as Record<string, unknown>;
				try { input.onEvent?.(event); } catch { /* Observers cannot fail the run. */ }
				lastEventAt = Date.now();
				lastEventLabel = describeAgentEvent(event);
				trackDeclaredTimeouts(declaredBudgets, event);
				if (event.type === "extension_ui_request") answerExtensionUi(event);
				if (event.type === "response") {
					// A command ack: pair it with what was sent so a refusal
					// surfaces through onCommandError instead of passing for noise.
					const id = typeof event.id === "string" ? event.id : undefined;
					const command = (id !== undefined ? pendingCommands.get(id) : undefined)
						?? (typeof event.command === "string" ? event.command : "unknown");
					if (id !== undefined) pendingCommands.delete(id);
					if (event.success === false) {
						const error = typeof event.error === "string" ? event.error : "command rejected";
						try { input.onCommandError?.({ command, error }); } catch { /* observers cannot fail a child run */ }
					}
				}
				// `agent_end` is the model's last message; `agent_settled` is the
				// turn's real end — pi may retry, compact, or drain a queue
				// between them. Idle, the per-turn wall clock and per-turn
				// results all key off `agent_settled`.
				if (event.type === "agent_start") {
					turnActive = true;
					// A fresh turn clears the previous turn's leftovers: a lane
					// that recovered must not report a stale failure, and a turn
					// that produced no text must not re-report the last answer.
					delete state.errorMessage;
					state.finalText = "";
					armTurnTimer();
					input.onIdleChange?.(false);
				} else if (event.type === "agent_settled") {
					turnActive = false;
					clearTurnTimer();
					input.onIdleChange?.(true);
					if (input.onTurnSettled) {
						const turn: AgentRunResult = state.errorMessage
							? { status: "failed", errorMessage: state.errorMessage, text: state.finalText, usage: state.usage }
							: {
								status: "completed",
								text: state.finalText,
								usage: state.usage,
								...(state.model ? { model: state.model } : {}),
								...(state.stopReason ? { stopReason: state.stopReason } : {}),
							};
						try { input.onTurnSettled(turn); } catch { /* observers cannot fail a child run */ }
					}
				}
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
				// A malformed event is protocol noise the fold never needs.
			}
		}));
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
			clearTurnTimer();
			boundDrain();
		});
		child.on("close", (code) => {
			exitCode = code;
			finish();
		});

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
		armTurnTimer();
		return handle;
	} catch (error) {
		await cleanupSystemPrompt();
		throw error;
	}
}
