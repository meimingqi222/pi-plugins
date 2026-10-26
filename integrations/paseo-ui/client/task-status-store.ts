import type { PaseoAgentTimelineHandle, PaseoAgentTimelineSubscription, PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import type { WorkStatus } from "../shared/work-status.ts";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { subagentCards, subagentStatuses, taskCardSource } from "./transform-status.ts";

type CardRow = { seq: number; rank: number; tasks: string[] };

type Conversation = {
  timeline: PaseoAgentTimelineHandle;
  listeners: Set<() => void>;
  tasks: Map<string, { seq: number; work: WorkStatus }>;
  cardRows: Map<string, CardRow>;
  cardSources: Map<string, string>;
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

  getCardSource(agentId: string, taskId: string): string | undefined {
    return this.conversations.get(agentId)?.cardSources.get(taskId);
  }

  subscribe(agentId: string, listener: () => void): () => void {
    let state = this.conversations.get(agentId);
    if (!state) {
      state = { timeline: this.timelineFor(agentId), listeners: new Set(), tasks: new Map(), cardRows: new Map(), cardSources: new Map(), generation: 0, stopped: false, loading: false, refreshRequested: false };
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
    state.cardRows.clear();
    state.cardSources.clear();
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

  private applyItem(state: Conversation, item: AgentTimelineItem, seq: number): void {
    this.apply(state, subagentStatuses(item), seq);
    const source = taskCardSource(item);
    if (!source) return;
    const previous = state.cardRows.get(source);
    if (previous && previous.seq >= seq) return;
    const tasks = subagentCards(item).map(card => card.id);
    const spawn = item.type === "tool_call" && item.name === "subagent";
    if (!previous && tasks.length === 0 && !spawn) return;
    // A finished foreground tool becomes a native answer. Keep its latest
    // sequence as a tombstone so older pages cannot resurrect its live card.
    let rank = 1;
    if (spawn) rank = 0;
    else if (item.type === "tool_call" && item.name === "subagent_tasks") rank = 2;
    state.cardRows.set(source, { seq, rank, tasks });
    let changed = false;
    for (const task of new Set([...(previous?.tasks ?? []), ...tasks])) {
      let winner: { source: string; row: CardRow } | undefined;
      for (const [candidate, row] of state.cardRows) {
        if (!row.tasks.includes(task)) continue;
        if (!winner || row.rank < winner.row.rank || (row.rank === winner.row.rank && row.seq < winner.row.seq)) {
          winner = { source: candidate, row };
        }
      }
      const next = winner?.source;
      if (state.cardSources.get(task) === next) continue;
      if (next) state.cardSources.set(task, next);
      else state.cardSources.delete(task);
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
          const seq = "seq" in message ? message.seq : undefined;
          const epoch = "epoch" in message ? message.epoch : undefined;
          if (epoch && state.epoch !== epoch) {
            this.reset(state, epoch);
            void this.refresh(state);
          }
          if (typeof seq === "number") this.applyItem(state, event.item, seq);
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
        for (const entry of page.entries) this.applyItem(state, entry.item, entry.seqEnd);
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
