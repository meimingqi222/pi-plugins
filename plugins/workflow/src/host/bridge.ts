/**
 * Parent side of the script host.
 *
 * Runs a workflow script in a `node:worker_threads` worker. The worker is what
 * makes a runaway script survivable: `terminate()` interrupts a synchronous
 * infinite loop, which no in-process guard can do. Measured on both Node and
 * Bun, a `while (true) {}` worker is killed in tens of milliseconds.
 *
 * Why a worker thread rather than a subprocess: a child process needs a second
 * interpreter, a temp entry file, and a framed wire, and it broke under Bun as a
 * spawned child (its `stdin` is `undefined`, so the handshake crashed). A worker
 * needs none of that, runs on both runtimes, and still gives the property that
 * matters — it can be terminated.
 *
 * The settlement rules below are the whole difficulty, and both were bugs once:
 *
 * 1. **Never wait for the worker to exit on its own.** The worker is kept alive
 *    by its own `parentPort` listener, so waiting for an `exit` event after
 *    `complete` deadlocks. Settlement is driven by the first terminal signal —
 *    a `complete`/`error` message, an `exit`, or a worker `error` — and the
 *    parent terminates the worker afterwards rather than waiting for it.
 * 2. **Never await an abandoned agent handler.** A callback that ignores its
 *    abort signal would hold `Promise.allSettled` open forever, so the drain is
 *    skipped once the run is aborted. The worker is already gone; a result it
 *    could have received is unreachable anyway.
 */

import { Worker } from "node:worker_threads";
import { renderWorkerSource } from "./worker-entry.ts";
import { isWorkerMessage } from "./protocol.ts";
import type { HostMessage } from "./protocol.ts";
import type { WorkflowAgentOptions } from "../core/types.ts";

export interface ScriptHostCallbacks {
  /** Run one agent. Rejecting fails the worker's `agent()` call. */
  agent(
    prompt: string,
    options: WorkflowAgentOptions,
    signal: AbortSignal,
  ): Promise<{ value: unknown; tokens: number }>;
  phase(title: string): void;
  log(message: string): void;
  /** Current token spend and limit, for the `budget` global. */
  budget(): { total: number | null; spent: number };
  /** Admission check, called before an agent starts. Throwing refuses the call. */
  admit?(calls: number): void;
  /**
   * Admission *preview* for a panel, called before any of its children start.
   * Throwing refuses the whole panel. Never reserves: each child still admits
   * its own call, so a reservation here would count them twice.
   */
  check?(calls: number): void;
}

export interface ScriptHostOptions {
  script: string;
  args: unknown;
  name: string;
  callbacks: ScriptHostCallbacks;
  /** Wall-clock cap for the whole script. The worker is terminated when it expires. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Memory cap for the worker, in MB. A script cannot grow the parent's heap past this. */
  memoryLimitMb?: number;
}

export interface ScriptHostResult {
  value: unknown;
  meta: unknown;
  /** True when the script reached `complete`; false for a timeout, kill, or crash. */
  completed: boolean;
  stopReason?: "completed" | "failed" | "aborted" | "timeout";
  errorMessage?: string;
  /** Agent calls admitted, for run accounting. */
  agentCalls: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MEMORY_LIMIT_MB = 256;

interface RunState {
  value: unknown;
  meta: unknown;
  completed: boolean;
  stopReason?: ScriptHostResult["stopReason"];
  errorMessage?: string;
  agentCalls: number;
}

/**
 * Run a workflow script in a worker.
 *
 * The worker is always terminated on the way out, including on success: a script
 * that left a live handle would otherwise keep a thread alive for the life of
 * the pi process.
 */
export async function runScriptHost(options: ScriptHostOptions): Promise<ScriptHostResult> {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const worker = new Worker(renderWorkerSource(), {
    eval: true,
    // `payload` is structured-cloned in, so a script cannot break out of the
    // source template; it never becomes part of the worker's code text.
    workerData: { payload: { script: options.script, args: options.args ?? null, name: options.name } },
    resourceLimits: { maxOldGenerationSizeMb: options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB },
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state: RunState = { value: null, meta: {}, completed: false, agentCalls: 0 };
  const inFlight = new Set<Promise<void>>();
  let workerError: string | undefined;

  /** Resolved by the first terminal signal. See rule 1 in the module note. */
  let settle!: () => void;
  const terminal = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const reply = (message: HostMessage): void => {
    try {
      worker.postMessage(message);
    } catch {
      // The worker already ended; the request that produced this reply is gone.
    }
  };

  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const kill = async (): Promise<void> => {
    try {
      await worker.terminate();
    } catch {
      // Already gone.
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    void kill();
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) {
    onAbort();
  } else {
    timer = setTimeout(() => controller.abort(new Error(`Workflow script timed out after ${timeoutMs}ms`)), timeoutMs);
  }

  worker.on("exit", () => settle());
  worker.on("error", (error) => {
    // A worker-level failure (a syntax error in the script, or a resource limit)
    // surfaces here, not as a wire message.
    workerError = error instanceof Error ? error.message : String(error);
    settle();
  });

  worker.on("message", (message: unknown) => {
    if (!isWorkerMessage(message)) return;
    switch (message.kind) {
      case "complete":
        state.value = message.value;
        state.meta = message.meta;
        state.completed = true;
        settle();
        return;
      case "error":
        state.stopReason = "failed";
        state.errorMessage = message.message;
        settle();
        return;
      case "phase":
        safeCallback(() => options.callbacks.phase(message.title));
        return;
      case "log":
        safeCallback(() => options.callbacks.log(message.message));
        return;
      case "budget": {
        const current = options.callbacks.budget();
        reply({
          kind: "budget-result",
          id: message.id,
          total: current.total,
          spent: current.spent,
          remaining: current.total === null ? null : Math.max(0, current.total - current.spent),
        });
        return;
      }
      case "admit": {
        // The panel's preview. Refusing here is what makes "refused whole"
        // true: the throw reaches the worker before any task has started.
        try {
          options.callbacks.check?.(message.calls);
          reply({ kind: "admit-result", id: message.id, ok: true });
        } catch (error) {
          reply({ kind: "admit-result", id: message.id, ok: false, error: errorText(error) });
        }
        return;
      }
      case "agent": {
        // Concurrent, because a panel the worker awaits in parallel must not be
        // serialized here.
        track(runAgent(message));
        return;
      }
      default:
        return;
    }
  });

  async function runAgent(message: { id: string; prompt: string; options: WorkflowAgentOptions }): Promise<void> {
    try {
      // Admission is checked before the agent starts, so a panel that would
      // exceed the budget is refused rather than partially run.
      options.callbacks.admit?.(1);
      state.agentCalls += 1;
    } catch (error) {
      reply({ kind: "agent-result", id: message.id, ok: false, error: errorText(error) });
      return;
    }
    try {
      const outcome = await options.callbacks.agent(message.prompt, message.options, controller.signal);
      if (controller.signal.aborted) return;
      // `spent` rides along so the worker's `budget` global moves as work is
      // admitted; without it the script reads a stale zero forever.
      reply({
        kind: "agent-result",
        id: message.id,
        ok: true,
        value: outcome.value,
        tokens: outcome.tokens,
        spent: options.callbacks.budget().spent,
      });
    } catch (error) {
      reply({ kind: "agent-result", id: message.id, ok: false, error: errorText(error) });
    }
  }

  try {
    await terminal;

    // Rule 2: an abandoned handler must not hold the run open. The worker is
    // already gone, so a result it can no longer receive does not matter.
    if (!controller.signal.aborted) {
      await Promise.allSettled([...inFlight]);
    }

    if (state.completed) {
      state.stopReason = "completed";
    } else if (controller.signal.aborted) {
      state.stopReason = "timeout";
      state.errorMessage = errorText(controller.signal.reason) || "The workflow script was stopped";
    } else if (workerError) {
      state.stopReason = "failed";
      state.errorMessage = workerError;
    } else if (!state.errorMessage) {
      state.stopReason = "failed";
      state.errorMessage = "The workflow script ended without a result";
    }

    return {
      value: state.value,
      meta: state.meta,
      completed: state.completed,
      stopReason: state.stopReason,
      errorMessage: state.errorMessage,
      agentCalls: state.agentCalls,
    };
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    if (options.signal) options.signal.removeEventListener("abort", onExternalAbort);
    await kill();
  }
}

/** A host callback must not be able to abort the run by throwing. */
function safeCallback(work: () => void): void {
  try {
    work();
  } catch {
    // Progress reporting is cosmetic; a failure here is not a run failure.
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
