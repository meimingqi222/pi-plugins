import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deliver after Pi's final queue check, when a new follow-up can wake a turn. */
export class SettledDeliveryQueue {
  private readonly pending: Array<() => void> = [];

  constructor(pi: Pick<ExtensionAPI, "on">) {
    pi.on("agent_settled", () => {
      for (const send of this.pending.splice(0)) send();
    });
  }

  /** send must recheck its origin and handle delivery errors. */
  deliver(isIdle: () => boolean, send: () => void): void {
    let idle = true;
    try { idle = isIdle(); } catch { /* Let the origin guard handle a torn-down context. */ }
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
