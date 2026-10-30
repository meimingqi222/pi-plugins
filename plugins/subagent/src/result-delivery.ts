import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DeliveryLedger, type DeliveryOffer } from "@meimingqi222/pi-run-core";
import { formatBackground } from "./background.ts";
import type { Lane } from "./lane.ts";

export interface ResultOrigin {
  isCurrent: () => boolean;
  isIdle: () => boolean;
  /**
   * Session that owns the result. Present for a launched lane; a durable offer
   * needs it to keep a result from replaying into a different conversation.
   * Tests may omit it, in which case delivery stays in-memory only.
   */
  sessionId?: string;
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
  private readonly pi: Pick<ExtensionAPI, "on" | "sendMessage" | "appendEntry">;
  private readonly ledger: DeliveryLedger;
  private readonly pending = new Map<string, PendingResult>();
  private readonly progress = new Map<string, ResultProgress>();

  constructor(pi: Pick<ExtensionAPI, "on" | "sendMessage" | "appendEntry">) {
    this.pi = pi;
    this.ledger = new DeliveryLedger(pi, {
      offerType: "subagent-delivery-offer",
      ackType: "subagent-delivery-ack",
    });
    pi.on("turn_end", (_event, ctx) => {
      if (!ctx?.signal?.aborted) this.flush("steer");
    });
    pi.on("agent_settled", () => this.flush("followUp"));
    // A result that was offered but never accepted by the host survives a
    // reload or a branch switch. Replay happens after the session boundary
    // handler in the plugin, so in-memory state is already clear.
    pi.on("session_start", (_event, ctx) => this.replay(ctx));
    pi.on("session_tree", (_event, ctx) => this.replay(ctx));
  }

  offer(record: Lane, origin: ResultOrigin): void {
    if (!origin.isCurrent() || !record.resultRevision) return;
    const key = this.key(record);
    if (this.isHandled(record) || this.pending.has(key)) return;
    const entry = { record, origin };
    this.pending.set(key, entry);
    // Offered before the send, for the same reason as a workflow result: the
    // process can exit between settlement and the settled-boundary delivery.
    if (origin.sessionId) {
      this.ledger.offer({
        id: this.deliveryId(record),
        runId: record.id,
        sessionId: origin.sessionId,
        customType: "subagent-result",
        content: this.content(record),
        display: true,
        wake: this.wake(record),
        // The full lane record is not reconstructible after a restart; the
        // content above is the answer, and these fields are what a renderer
        // needs to label it.
        details: { id: record.id, agent: record.agent, alias: record.alias, status: record.status },
      });
    }
    let idle = true;
    try { idle = origin.isIdle(); } catch {}
    if (idle) this.submit(key, entry, "followUp");
  }

  consume(record: Lane, signal?: AbortSignal): void {
    if (signal?.aborted || !record.resultRevision || laneResultText(record) === undefined) return;
    const state = this.state(record.id);
    state.consumedThrough = Math.max(state.consumedThrough, record.resultRevision);
    for (const [key, entry] of this.pending) {
      if (entry.record.id === record.id && this.isHandled(entry.record)) {
        // The model read the answer through show/wait/log, so a replay would
        // only repeat it. Acknowledge before dropping the in-memory entry.
        if (entry.origin.sessionId) this.ledger.ack(this.deliveryId(entry.record));
        this.pending.delete(key);
      }
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
      const triggerTurn = this.wake(record);
      this.pi.sendMessage({
        customType: "subagent-result",
        content: this.content(record),
        display: true,
        // The id is what makes a crash between send and ack harmless: the
        // transcript itself then proves the result was delivered.
        details: { ...record, deliveryId: this.deliveryId(record) },
      }, triggerTurn
        ? { triggerTurn: true, deliverAs: mode }
        : { triggerTurn: false });
      const state = this.state(record.id);
      state.submittedThrough = Math.max(state.submittedThrough, record.resultRevision ?? 0);
      this.pending.delete(key);
      if (origin.sessionId) this.ledger.ack(this.deliveryId(record));
    } catch {
      return;
    }
  }

  private content(record: Lane): string {
    return `${formatBackground(record)}\n\n${laneResultText(record) ?? "No answer was returned."}`;
  }

  private wake(record: Lane): boolean {
    const status = record.status === "running" ? record.result?.details?.status : record.status;
    return status === "completed" || status === "failed";
  }

  private deliveryId(record: Lane): string {
    return `sa:${record.id}:${record.resultRevision ?? 0}`;
  }

  /**
   * Deliver the newest unacknowledged revision per lane.
   *
   * A lane can answer several times across reply turns. Replaying every
   * revision after a long absence would read as a backlog of stale answers;
   * the newest one is the lane's current state, and the older offers are
   * acknowledged so they do not return on every boundary.
   */
  private replay(ctx: Pick<ExtensionContext, "sessionManager">): void {
    let sessionId: string;
    try { sessionId = ctx.sessionManager.getSessionId(); } catch { return; }
    const offers = this.ledger.pending(ctx, sessionId);
    if (offers.length === 0) return;
    const latest = new Map<string, DeliveryOffer>();
    for (const offer of offers) {
      const current = latest.get(offer.runId);
      if (!current || offer.createdAt >= current.createdAt) latest.set(offer.runId, offer);
    }
    for (const offer of offers) {
      const chosen = latest.get(offer.runId);
      if (chosen && chosen.id !== offer.id) this.ledger.ack(offer.id);
    }
    for (const offer of latest.values()) {
      try {
        this.pi.sendMessage({
          customType: offer.customType,
          content: offer.content,
          display: offer.display,
          details: { ...(offer.details ?? {}), deliveryId: offer.id },
        }, offer.wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
        this.ledger.ack(offer.id);
      } catch {
        // Keep the offer; the next start/tree boundary is the retry.
      }
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
