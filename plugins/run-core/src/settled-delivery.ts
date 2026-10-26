import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deliver after Pi's final queue check, when a new follow-up can wake a turn. */
export class SettledDeliveryQueue {
  private readonly pending: Array<() => void> = [];

  constructor(pi: Pick<ExtensionAPI, "on">) {
    pi.on("agent_settled", () => {
      // Take the batch before running it, but isolate each send: a caller that
      // forgot its own try/catch must cost its own result, not every result
      // queued behind it. The previous bare loop lost the rest of the batch on
      // the first throw.
      for (const send of this.pending.splice(0)) {
        try {
          send();
        } catch {
          // The queue's contract is delivery, not error reporting. A send that
          // fails has already had its chance to notify its origin.
        }
      }
    });
  }

  /** send must recheck its origin and handle delivery errors. */
  deliver(isIdle: () => boolean, send: () => void): void {
    let idle = false;
    try { idle = isIdle(); } catch { /* An unknown state must wait for the settled boundary. */ }
    if (idle) send();
    else this.defer(send);
  }

  /** Queue explicitly for the next agent_settled event, without an idle probe. */
  defer(send: () => void): void {
    this.pending.push(send);
  }

  clear(): void {
    this.pending.length = 0;
  }
}
