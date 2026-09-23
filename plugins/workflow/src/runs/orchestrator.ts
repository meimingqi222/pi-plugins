/**
 * One workflow run: wires the script host, the agent runner, the budget, and
 * the journal together.
 *
 * This is the layer where the pieces become a product. The host knows how to run
 * a script but not what an agent costs; the runner knows how to run an agent but
 * not which ones already ran; the journal knows what ran but not how to decide.
 * The orchestrator owns those decisions:
 *
 * - **Cache lookup before spend.** Every agent call is hashed and checked against
 *   a resumed journal before an executor is touched. Getting this order wrong is
 *   the difference between resume saving money and resume being a comment.
 * - **Admission before launch.** The budget is consulted before the agent starts,
 *   so a refused call costs nothing.
 * - **Concurrency bound.** A `parallel()` panel must be bounded or a script can
 *   open hundreds of child sessions at once.
 *
 * Everything external is injected (`executor`, `journal`, `clock`), so the whole
 * run can be tested without spawning a process or paying for a model.
 */

import { RunBudget, RunBudgetExceeded, type RunBudgetLimits } from "pi-run-core";
import { join } from "node:path";
import { workflowHash } from "../core/hash.ts";
import { emptyWorkflowUsage, mergeWorkflowUsage, workflowUsageTokens, type WorkflowProgress, type WorkflowProgressAgent, type WorkflowRunResult, type WorkflowUsage } from "../core/types.ts";
import { runScriptHost, type ScriptHostCallbacks } from "../host/bridge.ts";
import { runAgent, RunAgentError, type AgentExecutor } from "../runner/agent-runner.ts";
import { isWritingRole } from "../runner/roles.ts";
import type { WorkflowJournal } from "../runs/journal.ts";
import type { WorkflowAgentOptions } from "../core/types.ts";

export interface WorkflowRunOptions {
  script: string;
  args: unknown;
  name: string;
  cwd: string;
  /** How to run one agent. Injected so the run is testable without a subprocess. */
  executor: AgentExecutor;
  /** Resume source, when re-running with a previous journal. */
  journal?: WorkflowJournal;
  budget?: RunBudgetLimits;
  /** Live child agents. Bounds a `parallel()` panel. */
  maxConcurrency?: number;
  /** Wall-clock cap for the whole script, in milliseconds. */
  timeoutMs?: number;
  /** Wall-clock cap for each agent call, in milliseconds. */
  agentTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** Stable identifier for this run; generated when absent. */
  runId?: string;
  onProgress?(progress: WorkflowProgress): void;
}

/**
 * Default live-agent ceiling.
 *
 * Four rather than a higher number because a fan-out is only as reliable as the
 * provider behind it: many providers rate-limit or reject a burst of concurrent
 * sessions, and a refused call is a failed agent, not a queued one. The default
 * should be the safe one; a provider that tolerates more raises it with
 * `PI_WORKFLOW_MAX_CONCURRENCY`.
 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** The absolute ceiling the schema allows, independent of the provider default. */
const MAX_CONCURRENCY_LIMIT = 32;

/**
 * The agent-call cap applied when the caller sets no agent budget.
 *
 * Without a default the run is unbounded, which contradicts every other bound in
 * the plugin: concurrency is capped, the script is capped, and a `parallel()`
 * wide enough to matter would sail past all of them. Sixty-four is deliberately
 * generous rather than tight — the guideline asks for far fewer — because this is
 * the runaway backstop, not the intended working size, and a legitimate large
 * migration must not be cut off by it. `maxAgents` still sets an exact cap.
 */
export const DEFAULT_MAX_AGENTS = 64;

/**
 * A mutex serializing the agents that may write.
 *
 * Role isolation keeps a planner and a reviewer from writing, but it does not
 * stop two `developer` agents in the same panel from editing the same file, and
 * `roles.ts` calls the developer the single-writer role. This is what makes that
 * true: an agent whose declared role can write holds the lock for its whole
 * call. Only an *explicit* write-capable role takes it, so a script that
 * declares no role is not serialized — it asked for no role isolation, and
 * serializing every unprofiled agent would silently cost the common
 * analysis-shaped run all of its parallelism.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/**
 * The live-agent ceiling for this environment.
 *
 * `PI_WORKFLOW_MAX_CONCURRENCY` overrides the default so a provider that
 * tolerates more (or less) can be set once rather than per run. A malformed or
 * out-of-range value falls back to the default rather than disabling the bound.
 */
export function maxConcurrencyCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_WORKFLOW_MAX_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENCY;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY_LIMIT, Math.floor(value));
}

/**
 * The effective cap for one run.
 *
 * `maxConcurrency` can only *lower* the ceiling, never raise it: the ceiling is
 * the provider's tolerance, and a script that asks for more than it is clamped
 * rather than refused, because a clamped run still makes progress where a
 * refused one makes none.
 */
function resolveMaxConcurrency(requested: number | undefined): number {
  const ceiling = maxConcurrencyCeiling();
  return Math.min(ceiling, Math.max(1, requested ?? ceiling));
}

/**
 * A counter-based semaphore.
 *
 * Deliberately not a queue with cancellation: a waiting call is already inside
 * the worker's `await`, and the run's abort signal terminates the whole worker
 * rather than unwinding individual waiters. This bounds concurrency, which is
 * all it needs to do.
 */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  // A plain field, not a constructor parameter property: pi loads extensions
  // under Node, whose strip-only TypeScript support rejects parameter
  // properties, so the class would fail to load there.
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

/**
 * Run a workflow script to completion.
 *
 * Returns a result rather than throwing for a script failure, because "the
 * script threw" and "the harness broke" are different outcomes a caller must be
 * able to tell apart. A budget refusal inside the script is likewise a script
 * failure: the script had a chance to catch it.
 */
export async function runWorkflow(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `wf_${Math.floor(now()).toString(36)}`;
  const startedAt = now();
  // Each axis defaults independently: a caller who sets a token budget still
  // gets the fan-out backstop, and vice versa.
  const budget = new RunBudget({
    agents: options.budget?.agents ?? DEFAULT_MAX_AGENTS,
    tokens: options.budget?.tokens ?? null,
  });
  // Clamped to the provider ceiling (default four): many providers reject a
  // burst of concurrent child sessions, so a higher request must not silently
  // widen the panel past what the provider tolerates.
  const semaphore = new Semaphore(resolveMaxConcurrency(options.maxConcurrency));
  const writerLock = new Mutex();

  const agents: WorkflowProgressAgent[] = [];
  let usage: WorkflowUsage = emptyWorkflowUsage();
  let cacheHits = 0;
  let failures = 0;
  let currentPhase: string | undefined;
  // Parent-side, incremented per request. Deterministic because postMessage
  // delivery is FIFO and the worker sends in invocation order; safer than
  // parsing the worker's own ids.
  let sequence = 0;
  const phases: Array<{ title: string }> = [];
  const PROGRESS_WRITE_MIN_INTERVAL_MS = 500;
  /** Bound the reason carried in a snapshot, so one long error cannot bulk up progress.json. */
  const MAX_PROGRESS_ERROR_CHARS = 160;

  const emit = (message?: string): void => {
    const value = snapshot("running", message);
    options.onProgress?.(value);
    writeProgress(value);
  };

  const snapshot = (status: WorkflowProgress["status"], message?: string): WorkflowProgress => ({
    schemaVersion: 1,
    runId,
    name: options.name,
    status,
    startedAt,
    updatedAt: now(),
    ...(currentPhase ? { currentPhase } : {}),
    agents: agents.map((agent) => ({ ...agent })),
    completedAgents: agents.filter((agent) => agent.status === "completed" || agent.status === "cached").length,
    totalAgents: agents.length,
    spentTokens: workflowUsageTokens(usage),
    ...(message ? { message } : {}),
  });

  // Durable progress: written next to the journal so a run can be diagnosed from
  // disk after the process that owned it is gone. Throttled because a script can
  // `log()` in a tight loop; `settleProgress` forces the terminal write.
  let progressWrite: Promise<void> = Promise.resolve();
  let lastProgressWriteAt = Number.NEGATIVE_INFINITY;
  const writeProgress = (value: WorkflowProgress, force = false): void => {
    const journal = options.journal;
    if (!journal) return;
    const at = now();
    if (!force && at - lastProgressWriteAt < PROGRESS_WRITE_MIN_INTERVAL_MS) return;
    lastProgressWriteAt = at;
    progressWrite = progressWrite.then(() => journal.writeProgress(value)).catch(() => undefined);
  };

  async function settleProgress(result: WorkflowRunResult): Promise<void> {
    // A run the budget stopped is a specific kind of failure, and the progress
    // union has the word for it. A run that merely *overspent* still completed:
    // that fact rides on the result's stopReason rather than contradicting the
    // status on the other surface.
    const terminal: WorkflowProgress["status"] =
      result.status === "completed"
        ? "completed"
        : result.status === "aborted"
          ? "aborted"
          : budget.refused
            ? "budget_exceeded"
            : "failed";
    writeProgress(snapshot(terminal, result.stopReason), true);
    await progressWrite;
  }

  const callbacks: ScriptHostCallbacks = {
    phase(title) {
      currentPhase = title;
      phases.push({ title });
      emit(`phase: ${title}`);
    },
    log(message) {
      emit(message);
    },
    budget() {
      return { total: budget.limit("tokens"), spent: workflowUsageTokens(usage) };
    },
    admit(calls) {
      budget.admit(calls);
    },
    check(calls) {
      budget.check(calls);
    },
    async agent(prompt, agentOptions: WorkflowAgentOptions) {
      const index = sequence;
      sequence += 1;
      const callHash = workflowHash({ prompt, options: agentOptions as unknown });

      const record: WorkflowProgressAgent = {
        id: `a${index}`,
        label: agentOptions.label?.slice(0, 120) || `agent-${index}`,
        task: prompt.slice(0, 200),
        ...(agentOptions.phase ?? currentPhase ? { phase: agentOptions.phase ?? currentPhase } : {}),
        status: "running",
        startedAt: now(),
      };
      agents.push(record);
      emit();

      // Cached before admission: a resumed call costs nothing, so it must not be
      // refused by a budget the earlier run already spent.
      const cached = options.journal?.cached(index, callHash);
      if (cached && (cached.status === "completed" || cached.status === "cached")) {
        cacheHits += 1;
        record.status = "cached";
        record.finishedAt = now();
        // The host admitted this call before the orchestrator could tell it was a
        // cache hit, so hand the slot back: a reused call did no work and must
        // not spend the agent budget of the run that reused it.
        budget.release(1);
        // The run's spend does **not** grow here. `spentTokens` is what this run
        // was billed, and a reused call was billed to the earlier run; folding it
        // in would also disagree with the budget, which admits only live calls.
        // The reused call's size is still reported per agent, so a reader can see
        // how much work the cache saved.
        record.usageTokens = workflowUsageTokens(cached.usage);
        emit();
        // Record the reuse in *this* run's journal as well. Without it the new
        // journal has a gap at every cached call, so a second resume chained off
        // this run would stop at the first gap and re-run everything after it.
        // `cached` is reusable, so a later resume can reuse it in turn.
        await options.journal?.append({
          schemaVersion: 1,
          seq: index,
          callId: record.id,
          callHash,
          prompt,
          options: (agentOptions ?? {}) as never,
          status: "cached",
          result: cached.result,
          usage: cached.usage,
          attempt: cached.attempt,
          createdAt: now(),
        });
        return { value: cached.result, tokens: 0 };
      }

      await semaphore.acquire();
      try {
        const invoke = () =>
          runAgent({
            executor: options.executor,
            input: {
              prompt,
              options: agentOptions,
              cwd: options.cwd,
              runId,
              agentId: record.id,
              ...(options.agentTimeoutMs === undefined ? {} : { timeoutMs: options.agentTimeoutMs }),
              ...(options.journal
                ? { evidencePath: join(options.journal.paths.runDir, "agents", `${record.id}.jsonl`) }
                : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            },
            // The bridge already admitted this call once, so attempt 1 admits
            // zero agents — but still runs the token check, which is what stops
            // a retry after the budget was spent. Later attempts are new child
            // invocations and admit one each.
            admit: (attempt) => budget.admit(attempt === 1 ? 0 : 1),
            ...(options.signal ? { signal: options.signal } : {}),
          });
        // A declared write-capable role holds the single-writer lock for its
        // whole call, so two `developer` agents in one panel cannot edit the
        // same file at once.
        const outcome = isWritingRole(agentOptions.toolProfile) ? await writerLock.run(invoke) : await invoke();
        usage = mergeWorkflowUsage(usage, outcome.usage);
        budget.record(workflowUsageTokens(outcome.usage));
        record.status = "completed";
        record.finishedAt = now();
        record.usageTokens = workflowUsageTokens(outcome.usage);
        emit();
        // Journaled after success only: a failed call is not reusable, and
        // recording it as pending would let a resume inherit it.
        await options.journal?.append({
          schemaVersion: 1,
          seq: index,
          callId: record.id,
          callHash,
          prompt,
          options: (agentOptions ?? {}) as never,
          status: "completed",
          result: outcome.value,
          usage: outcome.usage,
          attempt: outcome.attempts,
          createdAt: now(),
        });
        return { value: outcome.value, tokens: workflowUsageTokens(outcome.usage) };
      } catch (error) {
        failures += 1;
        record.status = "failed";
        record.finishedAt = now();
        const message = error instanceof Error ? error.message : String(error);
        // Carry the reason on the record before it is emitted: the snapshot is
        // what a live reader sees, and `message` is only the last event, so a
        // later emit would erase it.
        record.error = message.slice(0, MAX_PROGRESS_ERROR_CHARS);
        // A failed attempt is real spend, and often the most expensive attempt —
        // a schema repair re-sends the whole conversation. Accounting for it is
        // what makes the run's budget and summary honest: without this a run
        // whose calls all failed reports zero tokens spent.
        const spent = error instanceof RunAgentError ? error.usage : undefined;
        if (spent) {
          usage = mergeWorkflowUsage(usage, spent);
          budget.record(workflowUsageTokens(spent));
        }
        emit(message);
        // Journal the failure as well as the successes. Without it a run whose
        // calls all failed left the run directory holding only `script.js`,
        // which is indistinguishable from a run that never started or is still
        // hanging — the exact confusion this entry removes. A failed entry is
        // not reusable, so resume still stops at it.
        await options.journal?.append({
          schemaVersion: 1,
          seq: index,
          callId: record.id,
          callHash,
          prompt,
          options: (agentOptions ?? {}) as never,
          status: "failed",
          usage: spent ?? emptyWorkflowUsage(),
          attempt: 0,
          createdAt: now(),
          error: message,
        });
        throw error;
      } finally {
        semaphore.release();
      }
    },
  };

  let hostResult: Awaited<ReturnType<typeof runScriptHost>>;
  try {
    hostResult = await runScriptHost({
      script: options.script,
      args: options.args,
      name: options.name,
      callbacks,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // A host-level failure (a broken worker) is a run failure, not a script one.
    const failed = finish("failed", error instanceof Error ? error.message : String(error));
    await settleProgress(failed);
    return failed;
  }

  // A script that threw is a failure, not an abort: "aborted" means the run was
  // stopped from outside (timeout or a stop request), and conflating the two
  // makes a crashed script look like a cancelled one.
  const status: WorkflowRunResult["status"] = hostResult.completed
    ? "completed"
    : hostResult.stopReason === "failed"
      ? "failed"
      : "aborted";
  const result = finish(status, hostResult.errorMessage);
  await settleProgress(result);
  return result;

  /**
   * What the budget did, when it did something worth reporting.
   *
   * `spentTokens` says what was spent but not whether the limit was respected:
   * a token limit is passive, so a run can cross it and still finish. Both facts
   * are the budget's own, and both are invisible without this — the journal has
   * them only for a reader who already suspects them.
   */
  function budgetNotice(): string | undefined {
    const parts: string[] = [];
    if (budget.overspent) parts.push(`token budget exceeded (${workflowUsageTokens(usage)} spent)`);
    if (budget.refused) parts.push("agent budget refused further calls");
    return parts.length > 0 ? parts.join("; ") : undefined;
  }

  function finish(status: WorkflowRunResult["status"], stopReason?: string): WorkflowRunResult {
    // The budget's own report rides along rather than competing with the script's
    // reason: a run can fail for a script reason and still have overspent.
    const reason = [stopReason, budgetNotice()].filter((part): part is string => Boolean(part)).join("; ");
    return {
      schemaVersion: 1,
      runId,
      name: options.name,
      status,
      value: hostResult?.value ?? null,
      meta: (hostResult?.meta ?? {}) as never,
      ...(options.journal ? { scriptPath: options.journal.paths.scriptPath } : {}),
      startedAt,
      finishedAt: now(),
      spentTokens: workflowUsageTokens(usage),
      cacheHits,
      agentCalls: agents.length,
      phases,
      ...(reason ? { stopReason: reason } : {}),
      ...(failures > 0 && !reason ? { stopReason: `${failures} agent call(s) failed` } : {}),
    };
  }
}

export { RunBudgetExceeded };
