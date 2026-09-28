/**
 * The resume rule, with no file I/O.
 *
 * A resumed run must reuse the work already paid for. The rule is
 * *content-addressed*: `callHash` covers all of a call's inputs — prompt and
 * options — so a matching hash is a legitimately reusable answer regardless of
 * the order the calls happened to be issued in. In `parallel()`/`pipeline()`
 * the request order follows child completion timing, and on resume cached
 * calls resolve instantly and reorder the rest; keying reuse on sequence
 * position would miss every call past the first timing difference.
 *
 * Occurrence counting keeps identity: the previous run's reusable entries are
 * indexed by hash into FIFO lists ordered by original `seq`, and the nth call
 * with a given hash consumes the nth entry for it — two identical prompts are
 * still two calls. A miss does not disable later lookups: a call whose prompt
 * depends on an earlier result simply has a different hash, and the
 * independent calls around it still reuse.
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
 * Content-addressed resume over a previous run's journaled calls.
 *
 * Construct with the previous run's entries, then ask `cached(seq, hash)`
 * before each call. `seq` is this run's own request index — it is journaled so
 * the new run's log stays a contiguous sequence — but reuse is keyed on the
 * hash alone, because parallel request order is timing-dependent.
 */
export class ResumeLog {
  private readonly byHash = new Map<string, WorkflowJournalEntry[]>();
  private loaded = 0;

  constructor(previous: readonly WorkflowJournalEntry[] = []) {
    // FIFO per hash, ordered by original seq: the nth identical call pairs with
    // the nth identical previous entry.
    const ordered = previous.filter(isJournalEntry).slice().sort((a, b) => a.seq - b.seq);
    for (const entry of ordered) {
      this.loaded += 1;
      if (entry.status !== "completed" && entry.status !== "cached") continue;
      const list = this.byHash.get(entry.callHash) ?? [];
      list.push(entry);
      this.byHash.set(entry.callHash, list);
    }
  }

  /** Whether a previous run's entries were loaded. */
  get active(): boolean {
    return this.loaded > 0;
  }

  /** Number of valid entries loaded from the previous run, for reporting. */
  get size(): number {
    return this.loaded;
  }

  /**
   * The cached result for this call, or `undefined` to run it live.
   *
   * A miss consumes nothing and disables nothing: later calls keep looking,
   * because a different hash is a different call, not a divergence boundary.
   */
  cached(_seq: number, callHash: string): WorkflowJournalEntry | undefined {
    const list = this.byHash.get(callHash);
    if (!list || list.length === 0) return undefined;
    const entry = list.shift();
    if (list.length === 0) this.byHash.delete(callHash);
    return entry;
  }

  /** Stop reusing cached work. Called on any divergence the caller detects itself. */
  disable(): void {
    this.byHash.clear();
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
