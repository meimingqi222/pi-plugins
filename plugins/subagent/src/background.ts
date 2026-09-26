import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails, SubagentProgress } from "./tool.ts";

export type BackgroundStatus = "running" | "completed" | "failed" | "aborted";
export const QUIET_ACTIVITY_WARNING_MS = 90_000;

/** Observability states: `stalled` is `running` plus quiet past the warning threshold. */
export type ChildState = BackgroundStatus | "stalled";

/**
 * The single place a running record becomes `stalled`.
 *
 * The widget, the fleet panel and `formatBackground` all answer "is this child
 * stuck" from here, so the surfaces cannot disagree. A child that has emitted
 * no progress event yet is quiet since its start time: `progress` is absent,
 * which is a spawn, not silence inside the run — it is still `stalled` when the
 * age alone exceeds the threshold.
 */
export function deriveChildState(record: Pick<BackgroundRecord, "status" | "startedAt" | "progress">, now: number): ChildState {
	if (record.status !== "running") return record.status;
	const lastActivityAt = record.progress?.lastActivityAt ?? record.startedAt;
	return now - lastActivityAt >= QUIET_ACTIVITY_WARNING_MS ? "stalled" : "running";
}

export interface BackgroundRecord {
  id: string;
  agent: string;
  /** Human-facing display name; falls back to a task-derived slug at launch. */
  alias: string;
  task: string;
  sessionId: string;
  status: BackgroundStatus;
  startedAt: number;
  finishedAt?: number;
  logPath?: string;
  progress?: SubagentProgress;
  result?: AgentToolResult<SubagentDetails>;
  errorMessage?: string;
}

interface ActiveRecord {
  record: BackgroundRecord;
  controller: AbortController;
}

/**
 * A human-facing name from a task's first line, for a launch that did not name
 * one. Keeps word characters, dashes and spaces; collapses the rest.
 */
export function deriveAlias(task: string, max = 24): string {
  const slug = (task.split("\n")[0] ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!slug) return "task";
  return slug.length > max ? `${slug.slice(0, max - 1)}…` : slug;
}

/** Session-local, bounded handles for single background delegations. */
export class BackgroundRegistry {
  private readonly active = new Map<string, ActiveRecord>();
  private readonly settled: BackgroundRecord[] = [];

  constructor(
    private readonly onSettled: (record: BackgroundRecord) => void,
    private readonly maxActive = 4,
    private readonly historyLimit = 20,
  ) {}

  launch(
    agent: string,
    task: string,
    sessionId: string,
    work: (signal: AbortSignal, id: string) => Promise<AgentToolResult<SubagentDetails>>,
    alias?: string,
  ): BackgroundRecord {
    if (this.active.size >= this.maxActive) {
      throw new Error(`At most ${this.maxActive} background subagents may run at once. Check or cancel one with subagent_tasks.`);
    }
    const record: BackgroundRecord = {
      id: `sa-${randomUUID()}`,
      agent,
      alias: alias?.trim() || deriveAlias(task),
      task,
      sessionId,
      status: "running",
      startedAt: Date.now(),
    };
    const controller = new AbortController();
    this.active.set(record.id, { record, controller });
    void Promise.resolve()
      .then(() => work(controller.signal, record.id))
      .then((result) => {
        record.result = result;
        record.status = result.details?.status === "running" ? "failed" : result.details?.status ?? "failed";
      })
      .catch((error: unknown) => {
        record.status = controller.signal.aborted ? "aborted" : "failed";
        record.errorMessage = error instanceof Error ? error.message : String(error);
      })
      .finally(() => this.settle(record));
    return { ...record };
  }

  get(sessionId: string, id: string): BackgroundRecord | undefined {
    const record = this.active.get(id)?.record ?? this.settled.find((item) => item.id === id);
    return record?.sessionId === sessionId ? publicRecord(record) : undefined;
  }

  getLogPath(sessionId: string, id: string): string | undefined {
    const record = this.active.get(id)?.record ?? this.settled.find((item) => item.id === id);
    return record?.sessionId === sessionId ? record.logPath : undefined;
  }

  list(sessionId: string): BackgroundRecord[] {
    const active = [...this.active.values()].map((item) => item.record);
    return [...active.reverse(), ...[...this.settled].reverse()]
      .filter((record) => record.sessionId === sessionId)
      .map(publicRecord);
  }

  setProgress(id: string, progress: SubagentProgress): void {
    const record = this.active.get(id)?.record;
    if (record) record.progress = progress;
  }

  setLogPath(id: string, logPath: string): void {
    const record = this.active.get(id)?.record;
    if (record) record.logPath = logPath;
  }

  stop(sessionId: string, id: string): boolean {
    const entry = this.active.get(id);
    if (!entry || entry.record.sessionId !== sessionId) return false;
    entry.controller.abort();
    return true;
  }

  stopAll(): void {
    for (const entry of this.active.values()) entry.controller.abort();
  }

  atCapacity(): boolean {
    return this.active.size >= this.maxActive;
  }

  /** Counts running children across every session; the fleet ticker starts on this. */
  activeCount(): number {
    return this.active.size;
  }

  get activeLimit(): number {
    return this.maxActive;
  }

  /**
   * Resolve when the record settles or the deadline hits — the same shape
   * `bg_tasks wait` offers, so a caller never needs a polling loop.
   */
  waitFor(sessionId: string, id: string, timeoutMs: number): Promise<BackgroundRecord | undefined> {
    const existing = this.get(sessionId, id);
    if (!existing || existing.status !== "running") return Promise.resolve(existing);
    return new Promise((resolve) => {
      const onSettled = (record: BackgroundRecord) => {
        if (record.id !== id) return;
        this.waiters.delete(onSettled);
        clearTimeout(timer);
        resolve(this.get(sessionId, id));
      };
      const timer = setTimeout(() => {
        this.waiters.delete(onSettled);
        resolve(this.get(sessionId, id));
      }, Math.max(0, timeoutMs));
      (timer as { unref?: () => void }).unref?.();
      this.waiters.add(onSettled);
    });
  }

  private readonly waiters = new Set<(record: BackgroundRecord) => void>();

  private settle(record: BackgroundRecord): void {
    if (!this.active.delete(record.id)) return;
    record.finishedAt = Date.now();
    this.settled.push(record);
    while (this.settled.length > this.historyLimit) this.settled.shift();
    const visible = publicRecord(record);
    for (const waiter of [...this.waiters]) {
      try {
        waiter(visible);
      } catch {
        // One waiter failing must not keep the others waiting.
      }
    }
    try {
      this.onSettled(visible);
    } catch {
      // A notification failure cannot resurrect an already settled run.
    }
  }
}

function publicRecord(record: BackgroundRecord): BackgroundRecord {
  const { logPath: _privateLogPath, ...visible } = record;
  return visible;
}

export function formatBackground(record: BackgroundRecord): string {
  const now = Date.now();
  const elapsed = Math.round(((record.finishedAt ?? now) - record.startedAt) / 1000);
  const tools = record.progress?.completedTools ? ` · ${record.progress.completedTools} tools` : "";
  const progress = record.progress;
  // A child that has never emitted an event still derives `stalled` from its
  // start time; the flag belongs on the plain line rather than being hidden.
  if (!progress) {
    const stall = deriveChildState(record, now) === "stalled"
      ? ` · no child event for ${formatDuration(Math.floor((now - record.startedAt) / 1_000))} (possible stall)`
      : "";
    return `${record.id} · ${record.agent} · ${record.status} · ${elapsed}s${tools}${stall}`;
  }

  const quietMs = Math.max(0, now - progress.lastActivityAt);
  const quiet = formatDuration(Math.floor(quietMs / 1_000));
  const latest = progress.recentActivity.at(-1);
  const activeTool = progress.activeTool ?? [latest?.toolName, latest?.target].filter(Boolean).join(" ");
  const phase = progress.phase === "tool"
    ? `tool ${activeTool || "execution"}`
    : progress.phase;
  const activity = deriveChildState(record, now) === "stalled"
    ? ` · no child event for ${quiet} (possible stall)`
    : ` · last ${progress.lastEvent} ${quiet} ago`;
  return `${record.id} · ${record.agent} · ${record.status} · ${elapsed}s${tools} · ${phase}${activity}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
}
