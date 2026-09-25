/**
 * Background workflow runs.
 *
 * A workflow exists for work too large for one turn: reviewing hundreds of files,
 * migrating hundreds of call sites. A tool that blocks the turn for the whole run
 * is the wrong shape for that — the conversation is stuck, and there is no way to
 * do anything else while it works. So a run is *launched*, and its result is
 * delivered back into the conversation when it settles.
 *
 * The registry owns the small amount of state that makes that safe:
 *
 * - **One abort controller per run**, so a long run can be stopped without
 *   touching the session's own signal.
 * - **A bounded history**, so listing runs cannot grow without limit.
 * - **A settle callback exactly once**, because a run that reported twice would
 *   deliver its result twice.
 *
 * It is transport-free: `launch` takes the work as a function, so the registry
 * can be tested without spawning anything, and the caller decides how a settled
 * run is delivered.
 */

import type { WorkflowProgress, WorkflowRunResult } from "../core/types.ts";

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface RunRecord {
  runId: string;
  /** Saved name, or `inline` / the script's basename. */
  name: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  /**
   * Latest progress snapshot, while the run is active.
   *
   * This is what makes a long run observable: phases reached, agents running and
   * for how long, tokens spent, and when progress last moved. Without it the
   * only thing a caller can say about a running run is that it has not settled.
   */
  progress?: WorkflowProgress;
  /** Per-agent wall-clock cap the caller requested, for liveness reporting. */
  agentTimeoutMs?: number;
  /** Present once the run settles successfully. */
  result?: WorkflowRunResult;
  /** Why it failed or was stopped, for the delivered notice. */
  message?: string;
}

export interface RunRegistryOptions {
  /** Called exactly once per run, when it settles. */
  onSettled?(record: RunRecord): void;
  /** Records kept after settling. Older ones are dropped. */
  historyLimit?: number;
  /**
   * How many runs may be active at once.
   *
   * Each active run holds up to a full panel of live agents, so an unbounded
   * number of runs is an unbounded number of child sessions — the same
   * saturation the per-run concurrency ceiling exists to prevent, reached from
   * the outside. Four matches the per-run ceiling's own reasoning.
   */
  maxActiveRuns?: number;
  now?(): number;
}

const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_MAX_ACTIVE_RUNS = 4;

/**
 * The active-run ceiling for this environment.
 *
 * `PI_WORKFLOW_MAX_ACTIVE_RUNS` overrides the default, so a host that tolerates
 * more concurrent runs sets it once rather than per launch. A malformed or
 * out-of-range value falls back to the default rather than removing the bound.
 */
export function maxActiveRunsCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_WORKFLOW_MAX_ACTIVE_RUNS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ACTIVE_RUNS;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_ACTIVE_RUNS;
  return Math.floor(value);
}

/** A run that has been launched but not yet settled. */
interface ActiveRun {
  record: RunRecord;
  controller: AbortController;
}

export class RunRegistry {
  private readonly active = new Map<string, ActiveRun>();
  private readonly settled: RunRecord[] = [];
  private readonly onSettled?: (record: RunRecord) => void;
  private readonly historyLimit: number;
  private readonly maxActiveRuns: number;
  private readonly now: () => number;

  constructor(options: RunRegistryOptions = {}) {
    this.onSettled = options.onSettled;
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.maxActiveRuns = Math.max(1, options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS);
    this.now = options.now ?? Date.now;
  }

  /**
   * Launch one run in the background.
   *
   * Returns the record immediately with `status: "running"`, so the caller can
   * hand the model a handle without waiting. The work is not awaited: its
   * resolution is what triggers settlement.
   */
  launch(
    descriptor: { runId: string; name: string; agentTimeoutMs?: number },
    work: (signal: AbortSignal) => Promise<WorkflowRunResult>,
  ): RunRecord {
    if (this.active.has(descriptor.runId)) {
      throw new Error(`Workflow run ${descriptor.runId} is already active`);
    }
    if (this.active.size >= this.maxActiveRuns) {
      throw new Error(
        `Workflow refused: ${this.maxActiveRuns} run${this.maxActiveRuns === 1 ? "" : "s"} already active. ` +
          "Stop one with /workflows stop, or raise PI_WORKFLOW_MAX_ACTIVE_RUNS.",
      );
    }
    const record: RunRecord = {
      runId: descriptor.runId,
      name: descriptor.name,
      status: "running",
      startedAt: this.now(),
      ...(descriptor.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: descriptor.agentTimeoutMs }),
    };
    const controller = new AbortController();
    this.active.set(descriptor.runId, { record, controller });

    // Deliberately not awaited. The rejection path is handled here rather than
    // left to the caller, because an unhandled rejection would take the process
    // down and a failed run is not a process-level failure.
    void work(controller.signal)
      .then((result) => {
        record.result = result;
        // The result's status is already the honest one: a script that threw is
        // "failed", not "aborted", and mapping it to anything else would
        // mislabel a crashed run as a completed or cancelled one.
        record.status = result.status;
        if (result.stopReason) record.message = result.stopReason;
      })
      .catch((error: unknown) => {
        // A launched run that throws is a harness failure, not a script one:
        // the orchestrator returns a result rather than throwing for a script
        // failure, so anything here is unexpected.
        record.status = controller.signal.aborted ? "aborted" : "failed";
        record.message = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.settle(record);
      });

    return { ...record };
  }

  /** Run state, active or settled. */
  get(runId: string): RunRecord | undefined {
    const active = this.active.get(runId);
    if (active) return { ...active.record };
    const settled = this.settled.find((record) => record.runId === runId);
    return settled ? { ...settled } : undefined;
  }

  /**
   * Replace a running run's progress snapshot.
   *
   * A settled run ignores later updates, so a progress event that arrives after
   * settlement cannot resurrect it or contradict its result.
   */
  setProgress(runId: string, progress: WorkflowProgress): void {
    const entry = this.active.get(runId);
    if (entry) entry.record.progress = progress;
  }

  /** Active runs first (newest first), then settled ones (newest first). */
  list(): RunRecord[] {
    const active = [...this.active.values()].map((entry) => ({ ...entry.record }));
    return [...active.reverse(), ...[...this.settled].reverse().map((record) => ({ ...record }))];
  }

  /** Runs that have not settled yet. */
  activeCount(): number {
    return this.active.size;
  }

  /** How many runs may be active at once. */
  get activeLimit(): number {
    return this.maxActiveRuns;
  }

  /**
   * Stop one run. Returns false when it is unknown or already settled.
   *
   * Only aborts; settlement happens through the work promise, so the record's
   * final status reflects what the run actually did rather than what was
   * requested of it.
   */
  stop(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.controller.abort(new Error("Workflow run stopped by request"));
    return true;
  }

  /** Stop every active run. Used on session shutdown. */
  stopAll(): void {
    for (const entry of this.active.values()) {
      entry.controller.abort(new Error("Workflow run stopped because the session ended"));
    }
  }

  /** Leave the current conversation without letting abort-ignoring work hold its run slots. */
  reset(): void {
    this.stopAll();
    this.active.clear();
    this.settled.length = 0;
  }

  private settle(record: RunRecord): void {
    if (!this.active.delete(record.runId)) return;
    record.finishedAt = this.now();
    this.settled.push(record);
    while (this.settled.length > this.historyLimit) this.settled.shift();
    // Guarded so a throwing callback cannot skip the bookkeeping above or
    // prevent a later run from settling.
    try {
      this.onSettled?.({ ...record });
    } catch {
      // A delivery failure is the callback's problem, not the registry's.
    }
  }
}

/** One-line description of a run, for a status notice. */
export function formatRun(record: RunRecord): string {
  const elapsed = Math.max(0, (record.finishedAt ?? Date.now()) - record.startedAt);
  const seconds = Math.round(elapsed / 100) / 10;
  const detail = record.result
    ? `${record.result.agentCalls} agents · ${record.result.spentTokens} tokens · ${record.result.cacheHits} cached`
    : (record.message ?? "");
  return `${record.runId}  ${record.status}  ${record.name}  ${seconds}s${detail ? `  ${detail}` : ""}`;
}
