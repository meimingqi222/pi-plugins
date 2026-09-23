/**
 * The resume rule, with no file I/O.
 *
 * A resumed run must reuse the work already paid for, and must *stop* reusing it
 * at the first point the script diverged. That "prefix only" rule is the whole
 * subtlety of resume, so it lives here as a pure object that can be tested
 * without a filesystem.
 *
 * The rule is one-way: once a call mismatches, or a recorded call is not
 * reusable, resume is disabled for the rest of the run and every later call
 * executes live. It never re-enables. A previous implementation that kept
 * looking for matches would return cached results for calls *after* the
 * divergence, which is worse than no cache at all: the run would silently mix
 * old work into a new execution.
 *
 * A malformed or truncated journal is handled by the reader, which stops at the
 * first unparseable line so only a verified contiguous prefix is ever offered
 * here. This module therefore trusts its entries and only applies the rule.
 */

import type { WorkflowJournalEntry } from "./types.ts";

/** Whether an entry may stand in for executing the call again. */
export function isReusable(entry: WorkflowJournalEntry | undefined, callHash: string): boolean {
  if (!entry) return false;
  if (entry.callHash !== callHash) return false;
  return entry.status === "completed" || entry.status === "cached";
}

/**
 * Prefix-only resume over a sequence of journaled calls.
 *
 * Construct with the previous run's entries, then ask `cached(seq, hash)` before
 * each call. Sequence numbers are per-run and monotonic, so the map is keyed by
 * `seq` rather than by hash: two identical prompts at different points in a
 * script are two calls, and a hash-keyed cache would collapse them into one.
 */
export class ResumeLog {
  private readonly entries = new Map<number, WorkflowJournalEntry>();
  private enabled: boolean;

  constructor(previous: readonly WorkflowJournalEntry[] = []) {
    for (const entry of previous) {
      if (isJournalEntry(entry)) this.entries.set(entry.seq, entry);
    }
    this.enabled = this.entries.size > 0;
  }

  /** Whether a previous run is still being replayed. */
  get active(): boolean {
    return this.enabled;
  }

  /** Number of entries loaded from the previous run, for reporting. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The cached result for this call, or `undefined` to run it live.
   *
   * Returning `undefined` permanently disables resume: the first divergence
   * means every later call is a new execution, and continuing to serve cached
   * results past it would corrupt the run.
   */
  cached(seq: number, callHash: string): WorkflowJournalEntry | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(seq);
    if (!isReusable(entry, callHash)) {
      this.enabled = false;
      return undefined;
    }
    return entry;
  }

  /** Stop reusing cached work. Called on any divergence the caller detects itself. */
  disable(): void {
    this.enabled = false;
  }
}

/**
 * Structural check for a journal line.
 *
 * A `failed` entry is admissible: it is not reusable (see `isReusable`), but it
 * is part of the sequence and must be visible. Without it a run whose calls all
 * failed left the run directory looking untouched, which is indistinguishable
 * from a run that never started or is still hanging.
 */
export function isJournalEntry(value: unknown): value is WorkflowJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkflowJournalEntry>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.seq === "number" &&
    Number.isSafeInteger(candidate.seq) &&
    candidate.seq >= 0 &&
    typeof candidate.callHash === "string" &&
    typeof candidate.callId === "string" &&
    (candidate.status === "completed" || candidate.status === "cached" || candidate.status === "failed")
  );
}
