import type { PaseoAgentTimelineHandle, PaseoAgentTimelineSubscription, PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import type { WorkStatus } from "../shared/work-status.ts";
import { subagentStatuses } from "./transform-status.ts";

type Conversation = {
  timeline: PaseoAgentTimelineHandle;
  listeners: Set<() => void>;
  tasks: Map<string, { seq: number; work: WorkStatus }>;
  epoch?: string;
  generation: number;
  stopped: boolean;
  loading: boolean;
  refreshRequested: boolean;
  subscription?: PaseoAgentTimelineSubscription;
  observationTimer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setTimeout>;
};

/** One observation per parent conversation, owned by its mounted cards. */
export class TaskStatusStore {
  private readonly conversations = new Map<string, Conversation>();
  constructor(private readonly timelineFor: (agentId: string) => PaseoAgentTimelineHandle) {}

  get(agentId: string, taskId: string): WorkStatus | undefined {
    return this.conversations.get(agentId)?.tasks.get(taskId)?.work;
  }

  subscribe(agentId: string, listener: () => void): () => void {
    let state = this.conversations.get(agentId);
    if (!state) {
      state = { timeline: this.timelineFor(agentId), listeners: new Set(), tasks: new Map(), generation: 0, stopped: false, loading: false, refreshRequested: false };
      this.conversations.set(agentId, state);
      this.observe(state);
    }
    state.listeners.add(listener);
    const current = state;
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size) {
        this.stop(current);
        this.conversations.delete(agentId);
      }
    };
  }

  private notify(state: Conversation): void {
    for (const listener of state.listeners) listener();
  }

  private reset(state: Conversation, epoch?: string): void {
    state.generation++;
    state.epoch = epoch;
    state.tasks.clear();
    this.notify(state);
  }

  private apply(state: Conversation, evidence: WorkStatus[], seq: number): void {
    let changed = false;
    for (const work of evidence) {
      const previous = state.tasks.get(work.id);
      if (previous && previous.seq >= seq) continue;
      // Metadata-only host updates have no counters or transcript reference.
      const next = { ...work, metric: work.metric || previous?.work.metric || "", liveLog: work.liveLog ?? previous?.work.liveLog };
      state.tasks.set(work.id, { seq, work: next });
      changed = true;
    }
    if (changed) this.notify(state);
  }

  private observe(state: Conversation): void {
    try {
      state.subscription = state.timeline.subscribe(({ event, ...message }) => {
        if (state.stopped) return;
        if (event.type === "error") { this.retryObservation(state); return; }
        if (event.type === "replacement") {
          this.reset(state, event.epoch);
          void this.refresh(state);
        } else if (event.type === "subscription_restored") {
          void this.refresh(state); // Reconnect may have missed terminal updates.
        } else if (event.type === "timeline") {
          const evidence = subagentStatuses(event.item);
          if (!evidence.length) return;
          const seq = "seq" in message ? message.seq : undefined;
          const epoch = "epoch" in message ? message.epoch : undefined;
          if (epoch && state.epoch !== epoch) {
            this.reset(state, epoch);
            void this.refresh(state);
          }
          if (typeof seq === "number") this.apply(state, evidence, seq);
          else void this.refresh(state);
        }
      });
      // Subscribe before reading history so completion during the read is seen.
      void state.subscription.ready.then(() => this.refresh(state), () => this.retryObservation(state));
    } catch { this.retryObservation(state); }
  }

  private retryObservation(state: Conversation): void {
    if (state.stopped) return;
    state.subscription?.();
    clearTimeout(state.observationTimer);
    state.observationTimer = setTimeout(() => { if (!state.stopped) this.observe(state); }, 1000);
  }

  private async refresh(state: Conversation): Promise<void> {
    if (state.stopped) return;
    if (state.loading) { state.refreshRequested = true; return; }
    state.loading = true;
    let generation = state.generation;
    try {
      let cursor: PaseoAgentTimelineRefetchOptions["cursor"] = undefined;
      do {
        const page = await state.timeline.refetch({ direction: cursor ? "before" : "tail", cursor, limit: 200, projection: "canonical" });
        if (state.stopped || state.generation !== generation) return;
        if (page.error) throw new Error(page.error);
        if (state.epoch && state.epoch !== page.epoch) {
          // A page from the old epoch cannot overwrite live replacement data.
          if (cursor) { state.refreshRequested = true; return; }
          this.reset(state, page.epoch);
          generation = state.generation;
        }
        state.epoch = page.epoch;
        for (const entry of page.entries) this.apply(state, subagentStatuses(entry.item), entry.seqEnd);
        const next = page.hasOlder ? page.startCursor : null;
        if (!next || (cursor && next.seq >= cursor.seq)) break;
        cursor = next;
      } while (cursor);
    } catch {
      // Keep the last confirmed state; a failed read does not prove completion.
      if (!state.stopped) {
        clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => { void this.refresh(state); }, 1000);
      }
    } finally {
      state.loading = false;
      if (state.refreshRequested && !state.stopped) {
        state.refreshRequested = false;
        void this.refresh(state);
      }
    }
  }

  private stop(state: Conversation): void {
    state.stopped = true;
    clearTimeout(state.observationTimer);
    clearTimeout(state.refreshTimer);
    state.subscription?.();
    state.listeners.clear();
  }
  dispose(): void {
    for (const state of this.conversations.values()) this.stop(state);
    this.conversations.clear();
  }
}
