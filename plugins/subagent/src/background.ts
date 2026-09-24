import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails, SubagentProgress } from "./tool.ts";

export type BackgroundStatus = "running" | "completed" | "failed" | "aborted";

export interface BackgroundRecord {
  id: string;
  agent: string;
  task: string;
  sessionId: string;
  status: BackgroundStatus;
  startedAt: number;
  finishedAt?: number;
  progress?: SubagentProgress;
  result?: AgentToolResult<SubagentDetails>;
  errorMessage?: string;
}

interface ActiveRecord {
  record: BackgroundRecord;
  controller: AbortController;
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
  ): BackgroundRecord {
    if (this.active.size >= this.maxActive) {
      throw new Error(`At most ${this.maxActive} background subagents may run at once. Check or cancel one with subagent_tasks.`);
    }
    const record: BackgroundRecord = {
      id: `sa-${randomUUID()}`,
      agent,
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
    return record?.sessionId === sessionId ? { ...record } : undefined;
  }

  list(sessionId: string): BackgroundRecord[] {
    const active = [...this.active.values()].map((item) => item.record);
    return [...active.reverse(), ...[...this.settled].reverse()]
      .filter((record) => record.sessionId === sessionId)
      .map((record) => ({ ...record }));
  }

  setProgress(id: string, progress: SubagentProgress): void {
    const record = this.active.get(id)?.record;
    if (record) record.progress = progress;
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

  get activeLimit(): number {
    return this.maxActive;
  }

  private settle(record: BackgroundRecord): void {
    if (!this.active.delete(record.id)) return;
    record.finishedAt = Date.now();
    this.settled.push(record);
    while (this.settled.length > this.historyLimit) this.settled.shift();
    try {
      this.onSettled({ ...record });
    } catch {
      // A notification failure cannot resurrect an already settled run.
    }
  }
}

export function formatBackground(record: BackgroundRecord): string {
  const elapsed = Math.round(((record.finishedAt ?? Date.now()) - record.startedAt) / 1000);
  const activity = record.progress?.activeTool ? ` · ${record.progress.activeTool}` : "";
  const tools = record.progress?.completedTools ? ` · ${record.progress.completedTools} tools` : "";
  return `${record.id} · ${record.agent} · ${record.status} · ${elapsed}s${tools}${activity}`;
}
