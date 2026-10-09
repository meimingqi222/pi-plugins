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
 * The settlement rules below are the whole difficulty, and each was a bug once:
 *
 * 1. **Never wait for the worker to exit on its own.** The worker is kept alive
 *    by its own `parentPort` listener, so waiting for an `exit` event after
 *    `complete` deadlocks. Settlement is driven by the first terminal signal —
 *    a `complete`/`error` message, an `exit`, or a worker `error` — and the
 *    parent terminates the worker afterwards rather than waiting for it.
 * 2. **Never await an abandoned agent handler without a bound.** A callback that
 *    ignores its abort signal would hold `Promise.allSettled` open forever, so
 *    the drain is skipped once the run is aborted, and otherwise bounded by
 *    `abandonedAgentDrainMs`. The worker is already gone; a result it could have
 *    received is unreachable anyway. The bound exists so a child that is
 *    mid-write can finish, not so the run can wait out the child's deadline —
 *    an unbounded wait held a run slot while the result already said
 *    `completed`.
 * 3. **Terminate at most once, and await the worker's `exit` rather than
 *    `terminate()`'s promise.** On Bun a second `terminate()` — or one issued
 *    after the worker already exited — never settles, so an abort path that
 *    terminated once eagerly and once in `finally` hung the run.
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
  /** Agent callback owns admission when it must check a resume cache first. */
  agentHandlesAdmission?: boolean;
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
  /**
   * How long agent calls the script left running may delay settlement, so a
   * child that is mid-write can finish instead of being cut off. Their results
   * are unreachable (the worker is gone), so this is a grace period, not a wait
   * for the child's own deadline. Defaults to 5s.
   */
  abandonedAgentDrainMs?: number;
  signal?: AbortSignal;
  /** Memory cap for the worker, in MB. A script cannot grow the parent's heap past this. */
  memoryLimitMb?: number;
}

export interface ScriptHostResult {
  value: unknown;
  meta: unknown;
  /** True when the script reached `complete`; false for a timeout, kill, or crash. */
  completed: boolean;
  /**
   * `completed` when the script returned and no agent was left running;
   * otherwise the completion is qualified by what was abandoned or why it
   * failed, because a run slot is released at that point.
   */
  stopReason?: string;
  errorMessage?: string;
  /** Agent calls admitted, for run accounting. */
  agentCalls: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MEMORY_LIMIT_MB = 256;
const DEFAULT_ABANDONED_AGENT_DRAIN_MS = 5_000;

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

  /**
   * Let the agents the script abandoned finish, but only for `graceMs`.
   *
   * Returns how many are still in flight when the grace expires; `inFlight` is
   * only emptied by a settling handler, so a non-zero count is exactly the set
   * of calls the run is giving up on.
   */
  async function drainInFlight(graceMs: number): Promise<number> {
    if (inFlight.size === 0) return 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return inFlight.size;
  }

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

  // Termination is requested at most once, and callers wait on the worker's
  // `exit` rather than on `terminate()`'s promise. On Bun a second
  // `terminate()` — or one issued after the worker already exited — never
  // settles, so awaiting it would hang every abort path (timeout, external
  // stop) after `onAbort` and `finally` each asked for termination.
  let terminateRequested = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const kill = async (): Promise<void> => {
    if (!terminateRequested) {
      terminateRequested = true;
      try {
        void worker.terminate().catch(() => undefined);
      } catch {
        // `terminate()` can also throw synchronously; the worker is already gone.
      }
    }
    await exited;
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

  worker.on("exit", () => {
    resolveExited();
    settle();
  });
  worker.on("error", (error) => {
    // A worker-level failure (a syntax error in the script, or a resource limit)
    // surfaces here, not as a wire message. `error` is terminal, so it releases
    // `kill()` even if this runtime does not follow it with `exit`.
    workerError = error instanceof Error ? error.message : String(error);
    resolveExited();
    settle();
  });

  worker.on("message", (message: unknown) => {
    if (!isWorkerMessage(message)) return;
    switch (message.kind) {
      case "complete":
        try {
          // Structured clone accepts BigInt, Map and other values the public
          // result renderer and journal cannot serialize. Reject them here,
          // before a run can be recorded as completed but never delivered.
          const json = (_key: string, value: unknown): unknown => {
            if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" ||
              (value !== null && typeof value === "object" && !Array.isArray(value) &&
                Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
              throw new Error("Workflow result and meta must contain only JSON values");
            }
            return value;
          };
          state.value = JSON.parse(JSON.stringify(message.value, json));
          state.meta = JSON.parse(JSON.stringify(message.meta, json));
          state.completed = true;
        } catch {
          state.stopReason = "failed";
          state.errorMessage = "Workflow result and meta must contain only JSON values";
        }
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
      if (!options.callbacks.agentHandlesAdmission) options.callbacks.admit?.(1);
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
    // already gone, so a result it can no longer receive does not matter — the
    // drain is only a grace period for a child that is mid-write.
    let abandoned = 0;
    if (!controller.signal.aborted) {
      abandoned = await drainInFlight(options.abandonedAgentDrainMs ?? DEFAULT_ABANDONED_AGENT_DRAIN_MS);
    }

    if (state.completed) {
      // The run's value is final, so completion is still completion; saying what
      // was left behind is what keeps `/workflows` from reporting a settled run
      // as if every call it started had produced something.
      state.stopReason = abandoned > 0
        ? `completed; ${abandoned} agent call(s) were still running at script exit`
        : "completed";
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
