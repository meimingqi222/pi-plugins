/**
 * Delivering a run's continuation back into the session.
 *
 * A run-oriented extension drives itself by handing pi a message and asking for
 * a turn. That message cannot be unsent: once `sendMessage` returns, a turn will
 * start even if the run was paused or cleared in between. The extension
 * therefore has to remember that it has a delivery outstanding, and consume that
 * fact when the turn actually starts — otherwise a stopped run silently pays for
 * one more turn, and a turn it started is indistinguishable from one the user
 * asked for.
 *
 * Both facts matter downstream, so both live here:
 *
 * - `outstanding` lets a command tell whether the turn it is about to see was
 *   its own work, which is what scopes interruption to goal-driven turns.
 * - Consuming on `agent_start` makes the flag per attempt, not per run, so a
 *   user follow-up arriving inside a continuation-started run is correctly
 *   reported as user-driven.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Message body accepted by pi's `sendMessage`, taken from pi rather than restated. */
export type ContinuationContent = Parameters<
  Pick<ExtensionAPI, "sendMessage">["sendMessage"]
>[0]["content"];

export interface ContinuationDelivery {
  /** Message family, so the transcript can render and filter it by kind. */
  customType: string;
  /** Hidden from the transcript by default; a continuation is machine context, not conversation. */
  display?: boolean;
  details?: unknown;
}

/**
 * How the message lands relative to the current run.
 *
 * `immediate` starts a turn now and is only safe when the session is idle.
 * `queued` waits for the current run to finish, which is what a settled-boundary
 * continuation needs because pi may still be doing retry or compaction work.
 */
export type ContinuationMode = "immediate" | "queued";

export class ContinuationChannel {
  private outstanding = false;
  // A plain field, not a constructor parameter property: pi loads extensions
  // under Node, whose strip-only TypeScript support rejects parameter
  // properties, so the class would fail to load there.
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;

  constructor(pi: Pick<ExtensionAPI, "sendMessage">) {
    this.pi = pi;
  }

  /**
   * Whether a delivery is pending and no attempt has started since.
   *
   * Read this inside `agent_start`; the attempt it is about to describe was
   * started by the extension when true.
   */
  get isOutstanding(): boolean {
    return this.outstanding;
  }

  /**
   * Deliver a continuation and request a turn.
   *
   * Returns false when pi refused the message (a throw), so the caller can
   * settle the run instead of leaving it waiting on a turn that will never come.
   */
  deliver(mode: ContinuationMode, delivery: ContinuationDelivery, content: ContinuationContent): boolean {
    this.outstanding = true;
    try {
      this.pi.sendMessage(
        {
          customType: delivery.customType,
          content,
          display: delivery.display ?? false,
          details: delivery.details,
        },
        mode === "immediate"
          ? { triggerTurn: true }
          : { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch {
      this.outstanding = false;
      return false;
    }
  }

  /**
   * Consume the outstanding flag for the attempt starting now.
   *
   * Every `agent_start` must call this exactly once, whether or not it goes on
   * to do any work, or the flag leaks into the next attempt and misattributes a
   * user turn to the extension.
   */
  consume(): boolean {
    const value = this.outstanding;
    this.outstanding = false;
    return value;
  }

  /** Drop any pending delivery, without consuming it. Call on session boundaries. */
  reset(): void {
    this.outstanding = false;
  }
}
