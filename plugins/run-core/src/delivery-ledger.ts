/**
 * Durable bookkeeping for a result that must reach the conversation exactly
 * once, even across a reload or a branch switch.
 *
 * A background run settles after the turn that launched it is gone. The current
 * delivery path sends a custom message if the origin is still current and
 * discards it otherwise, so a result that settles while the session is being
 * left — or a process that exits between settlement and send — is lost even
 * though the work was paid for.
 *
 * The ledger is deliberately separate from the transport. It records an *offer*
 * (the message body and enough identity to replay it) before delivery, and an
 * *ack* after the host accepted the message. A branch that still holds an
 * unacked offer is the recovery set; a branch that holds the message itself is
 * treated as delivered even without an ack, which covers a crash between send
 * and ack.
 *
 * Both writes are best-effort. Durability must never fail a run: a full disk
 * costs the replay, not the result the user is waiting for.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface DeliveryOffer {
  /** Unique per delivery; also written into the message details for dedupe. */
  id: string;
  runId: string;
  /** Session that owns the result. A different session must not replay it. */
  sessionId: string;
  customType: string;
  content: string;
  display: boolean;
  /**
   * Whether the replay should wake a turn, matching the live delivery policy.
   * A failed result wakes the model; an aborted one is transcript-only.
   */
  wake: boolean;
  /** Minimal metadata the message renderer needs when the run record is gone. */
  details?: Record<string, unknown>;
  createdAt: number;
}

export interface DeliveryLedgerOptions {
  offerType?: string;
  ackType?: string;
  now?: () => number;
}

const DEFAULT_OFFER_TYPE = "delivery-offer";
const DEFAULT_ACK_TYPE = "delivery-ack";

interface StoredOffer extends DeliveryOffer {
  schema: 1;
}

function isStoredOffer(value: unknown): value is StoredOffer {
  if (!value || typeof value !== "object") return false;
  const offer = value as Record<string, unknown>;
  return offer.schema === 1 &&
    typeof offer.id === "string" && !!offer.id &&
    typeof offer.runId === "string" &&
    typeof offer.sessionId === "string" && !!offer.sessionId &&
    typeof offer.customType === "string" && !!offer.customType &&
    typeof offer.content === "string" &&
    typeof offer.display === "boolean" &&
    typeof offer.wake === "boolean" &&
    typeof offer.createdAt === "number";
}

export class DeliveryLedger {
  private readonly pi: Pick<ExtensionAPI, "appendEntry">;
  private readonly offerType: string;
  private readonly ackType: string;
  private readonly now: () => number;

  constructor(pi: Pick<ExtensionAPI, "appendEntry">, options: DeliveryLedgerOptions = {}) {
    this.pi = pi;
    this.offerType = options.offerType ?? DEFAULT_OFFER_TYPE;
    this.ackType = options.ackType ?? DEFAULT_ACK_TYPE;
    this.now = options.now ?? Date.now;
  }

  /** Record an offer before delivery. Returns false when it could not be persisted. */
  offer(input: Omit<DeliveryOffer, "createdAt">): boolean {
    try {
      this.pi.appendEntry(this.offerType, { schema: 1, ...input, createdAt: this.now() } satisfies StoredOffer);
      return true;
    } catch {
      // Durability is an enhancement; the live delivery still gets its chance.
      return false;
    }
  }

  /** Mark a delivery as accepted by the host. Idempotent by entry, not by state. */
  ack(id: string): boolean {
    try {
      this.pi.appendEntry(this.ackType, { schema: 1, id });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Offers on the active branch that have neither an ack nor a delivered
   * message in the transcript.
   *
   * The message check is what makes a crash between send and ack harmless: the
   * custom message carries `details.deliveryId`, and its presence is proof that
   * the host already accepted the result.
   */
  pending(
    ctx: Pick<ExtensionContext, "sessionManager">,
    sessionId: string,
  ): DeliveryOffer[] {
    let entries: unknown[];
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return [];
    }
    const offers = new Map<string, StoredOffer>();
    const acked = new Set<string>();
    const delivered = new Set<string>();
    for (const raw of entries) {
      const entry = raw as {
        type?: string;
        customType?: string;
        data?: unknown;
        details?: { deliveryId?: unknown; deliveryIds?: unknown };
      };
      if (entry?.type === "custom") {
        if (entry.customType === this.offerType && isStoredOffer(entry.data)) {
          // The newest offer for an id wins; a re-offer is the same delivery.
          offers.set(entry.data.id, entry.data);
        } else if (entry.customType === this.ackType && entry.data && typeof entry.data === "object") {
          const id = (entry.data as { id?: unknown }).id;
          if (typeof id === "string") acked.add(id);
        }
        continue;
      }
      if (entry?.type === "custom_message") {
        if (typeof entry.details?.deliveryId === "string") delivered.add(entry.details.deliveryId);
        // A batched message covers several offers; one id in the details is
        // not enough to prove the others were delivered.
        if (Array.isArray(entry.details?.deliveryIds)) {
          for (const id of entry.details.deliveryIds) {
            if (typeof id === "string") delivered.add(id);
          }
        }
      }
    }
    return [...offers.values()]
      .filter((offer) => offer.sessionId === sessionId && !acked.has(offer.id) && !delivered.has(offer.id))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(({ schema: _schema, ...offer }) => offer);
  }
}
