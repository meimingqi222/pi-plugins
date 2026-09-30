import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatBackground } from "./background.ts";
import type { Lane } from "./lane.ts";

export interface ResultOrigin {
  isCurrent: () => boolean;
  isIdle: () => boolean;
}

interface PendingResult {
  record: Lane;
  origin: ResultOrigin;
}

interface ResultProgress {
  submittedThrough: number;
  consumedThrough: number;
}

export function laneResultText(record: Lane): string | undefined {
  const answer = record.result?.content.find((item) => item.type === "text");
  return answer?.type === "text" ? answer.text : record.errorMessage;
}

export class SubagentResultDelivery {
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly pending = new Map<string, PendingResult>();
  private readonly progress = new Map<string, ResultProgress>();

  constructor(pi: Pick<ExtensionAPI, "on" | "sendMessage">) {
    this.pi = pi;
    pi.on("turn_end", (_event, ctx) => {
      if (!ctx?.signal?.aborted) this.flush("steer");
    });
    pi.on("agent_settled", () => this.flush("followUp"));
  }

  offer(record: Lane, origin: ResultOrigin): void {
    if (!origin.isCurrent() || !record.resultRevision) return;
    const key = this.key(record);
    if (this.isHandled(record) || this.pending.has(key)) return;
    const entry = { record, origin };
    this.pending.set(key, entry);
    let idle = true;
    try { idle = origin.isIdle(); } catch {}
    if (idle) this.submit(key, entry, "followUp");
  }

  consume(record: Lane, signal?: AbortSignal): void {
    if (signal?.aborted || !record.resultRevision || laneResultText(record) === undefined) return;
    const state = this.state(record.id);
    state.consumedThrough = Math.max(state.consumedThrough, record.resultRevision);
    for (const [key, entry] of this.pending) {
      if (entry.record.id === record.id && this.isHandled(entry.record)) this.pending.delete(key);
    }
  }

  clear(): void {
    this.pending.clear();
    this.progress.clear();
  }

  private flush(mode: "steer" | "followUp"): void {
    for (const [key, entry] of [...this.pending]) this.submit(key, entry, mode);
  }

  private submit(key: string, entry: PendingResult, mode: "steer" | "followUp"): void {
    const { record, origin } = entry;
    if (!origin.isCurrent() || this.isHandled(record)) {
      this.pending.delete(key);
      return;
    }
    try {
      const status = record.status === "running" ? record.result?.details?.status : record.status;
      const triggerTurn = status === "completed" || status === "failed";
      this.pi.sendMessage({
        customType: "subagent-result",
        content: `${formatBackground(record)}\n\n${laneResultText(record) ?? "No answer was returned."}`,
        display: true,
        details: record,
      }, triggerTurn
        ? { triggerTurn: true, deliverAs: mode }
        : { triggerTurn: false });
      const state = this.state(record.id);
      state.submittedThrough = Math.max(state.submittedThrough, record.resultRevision ?? 0);
      this.pending.delete(key);
    } catch {
      return;
    }
  }

  private isHandled(record: Lane): boolean {
    const state = this.progress.get(record.id);
    return state !== undefined && (record.resultRevision ?? 0) <= Math.max(state.submittedThrough, state.consumedThrough);
  }

  private state(id: string): ResultProgress {
    let state = this.progress.get(id);
    if (!state) {
      state = { submittedThrough: 0, consumedThrough: 0 };
      this.progress.set(id, state);
    }
    return state;
  }

  private key(record: Lane): string {
    return `${record.id}:${record.resultRevision}`;
  }
}
