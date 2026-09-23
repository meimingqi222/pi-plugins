/**
 * Token accounting for a run's model traffic.
 *
 * Kept here rather than in each plugin because the number decides whether a
 * budget stops work: two plugins that disagree about what a message cost will
 * disagree about when a run ends. The ordering below is part of the contract —
 * a provider that reports `totalTokens` has already decided what belongs in it,
 * and re-deriving input+output over the top would double-count cached reads.
 */

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Tokens billed for one finalized assistant message, or 0 when it carries none.
 *
 * `totalTokens` wins when present, because it is the provider's own total and is
 * the only field guaranteed to include cache reads and writes. Only when it is
 * absent is the sum derived, and then all four fields are included so a cached
 * conversation is not silently billed as free.
 */
export function readTokenUsage(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const value = (message as { usage?: Record<string, unknown> }).usage;
  if (!value) return 0;
  if (natural(value.totalTokens)) return value.totalTokens;
  return ["input", "output", "cacheRead", "cacheWrite"].reduce(
    (sum, key) => sum + (natural(value[key]) ? value[key] : 0),
    0,
  );
}

/**
 * Bumps a wall-clock baseline and folds the elapsed span into a stored counter.
 *
 * Active-time accounting has to survive pause and resume without losing the
 * sub-second remainder: flooring each span independently drops up to a second
 * per boundary, and a goal that pauses often would under-report its own elapsed
 * time. The remainder is carried forward instead.
 */
export class ActiveTimer {
  private accumulatedMs: number;
  private remainderMs = 0;
  private since: number | undefined;
  // A plain field rather than a constructor parameter property: pi loads
  // extensions under Node, whose strip-only TypeScript support rejects parameter
  // properties, so the guarded constructor would fail to load there.
  private readonly now: () => number;

  constructor(accumulatedMs = 0, now: () => number = Date.now) {
    this.now = now;
    this.accumulatedMs = Number.isFinite(accumulatedMs) && accumulatedMs > 0 ? Math.floor(accumulatedMs) : 0;
  }

  /** Start counting, if not already running. Idempotent. */
  start(): void {
    this.since ??= this.readNow();
  }

  /**
   * Reset to a known accumulated total and start counting.
   *
   * Used when a persisted snapshot is the authority for elapsed time — on
   * restore, and when a new run replaces an old one. Starting from the snapshot
   * instead of zero is what keeps the reported total monotonic across a reload.
   */
  restart(accumulatedMs = 0): void {
    this.accumulatedMs = Number.isFinite(accumulatedMs) && accumulatedMs > 0 ? Math.floor(accumulatedMs) : 0;
    this.remainderMs = 0;
    this.since = this.readNow();
  }

  /** Stop counting and keep what has been accumulated so far. Idempotent. */
  stop(): void {
    if (this.since === undefined) return;
    this.capture();
    this.since = undefined;
  }

  /** Accumulated milliseconds, including the span still running. */
  elapsedMs(): number {
    return this.accumulatedMs + (this.since === undefined ? 0 : Math.max(0, this.readNow() - this.since));
  }

  /** Accumulated whole seconds, for a counter that is persisted as seconds. */
  elapsedSeconds(): number {
    return Math.floor(this.elapsedMs() / 1_000);
  }

  /**
   * Fold the running span into the accumulated total and restart from now,
   * preserving the sub-second remainder. Call before every persistence boundary
   * so a saved snapshot never counts the same span twice.
   */
  capture(): number {
    if (this.since === undefined) return this.accumulatedMs;
    this.remainderMs += Math.max(0, this.readNow() - this.since);
    this.accumulatedMs += Math.floor(this.remainderMs / 1_000) * 1_000;
    this.remainderMs %= 1_000;
    this.since = this.readNow();
    return this.accumulatedMs;
  }

  /** Whether the timer is currently counting. */
  get running(): boolean {
    return this.since !== undefined;
  }

  private readNow(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }
}
