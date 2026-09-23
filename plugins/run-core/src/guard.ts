/**
 * Staleness guards for asynchronous run work.
 *
 * Every await in a run handler is a window in which the user can pause, clear,
 * replace, or switch sessions. A result that lands after that window must not be
 * applied: a stale verifier verdict can complete a goal the user already
 * replaced, and a stale continuation can start a turn for a goal that no longer
 * exists. Those are correctness bugs, not races to be tolerated.
 *
 * A guard is a pair of monotonic counters plus a token issued at the start of an
 * operation. `invalidate()` bumps the epoch, so every outstanding token dies at
 * once; the session counter additionally dies on session replacement, which must
 * be a boundary even though it is not an invalidation the plugin performed.
 *
 * Kept in this package because it is small, subtle, and has already been the
 * site of a real bug. Two copies would drift, and the failure mode of the drift
 * is silent: work from a superseded run lands on current state.
 */

export interface RunToken {
  readonly epoch: number;
  readonly session: number;
}

export class RunGuard {
  private epoch = 0;
  private session = 0;

  /** Issue a token for work that starts now. */
  issue(): RunToken {
    return { epoch: this.epoch, session: this.session };
  }

  /**
   * Whether a token is still current.
   *
   * Compares both counters rather than a boolean flag per operation, so a token
   * issued before an invalidation can never be resurrected by a later one.
   */
  isCurrent(token: RunToken): boolean {
    return token.epoch === this.epoch && token.session === this.session;
  }

  /** Supersede all outstanding tokens. Call on pause, clear, and replace. */
  invalidate(): number {
    this.epoch += 1;
    return this.epoch;
  }

  /** Mark a session boundary. Supersedes outstanding tokens and changes identity. */
  nextSession(): number {
    this.session += 1;
    return this.session;
  }

  /** Current counters, for callers that persist or compare them directly. */
  snapshot(): RunToken {
    return { epoch: this.epoch, session: this.session };
  }

  /** Session identity as of now. A guard change means the session was replaced. */
  get sessionId(): number {
    return this.session;
  }
}
