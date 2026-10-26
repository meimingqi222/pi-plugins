# Agent Note: Exclude admission queue time from the workflow run timeout

Status: implemented

## Problem

`runTimeoutMs` was armed once when the script host started and measured pure
wall-clock. Once admission made runs wait for provider tickets
(`2026-10-26-global-provider-admission.md`), a run parked behind other runs
burned its own deadline doing nothing: with the 30-minute default and enough
contention, a run could reach the cap never having run an agent. The abort was
also mislabeled — the run was not hung, it was queued.

## Decision

The script host's timer now reads a live exclusion accumulator, and the
orchestrator feeds it.

- `runWorkflow` tracks the wall time its agents spend inside
  `admission.acquire` as the **union** of the queued intervals: two agents
  parked together for one second cost the provider one second of capacity, so
  the run is billed one. A depth counter opens the interval at the first waiter
  and closes it when the last one drains.
- The accumulator is a getter, not a snapshot. An agent still parked has not
  drained, so a closed total alone would let the timer fire mid-wait; the first
  version of this change failed exactly that way.
- `runScriptHost` accepts `excludedTime` and re-arms its timer at fire time
  instead of aborting when `startedAt + timeoutMs + excluded.totalMs` is still
  in the future. Re-arming (rather than arming once with a fixed extension) is
  what lets the exclusion keep growing after the first fire.

Only admission waits count. The run-local semaphore is the script's own fan-out
shape, and the writer lock is the script's own role isolation; both are ordinary
execution time and stay billed.

## Alternatives considered

**Measure per-agent wait and sum it.** Overlapping waits double-count: a panel
of four parked for one second would move the deadline by four.

**Start the timeout at the first running agent.** A script that does host-only
work before its first agent call would get unbounded setup time, and a
no-agent script would get no cap at all.

**Refuse the run when the queue is deep.** Admission is fair round-robin, so
the wait is bounded as long as tickets cycle; refusing would turn contention
into failures, the exact behavior admission exists to prevent.

## Consequences

A run parked behind other runs no longer dies of old age. The corollary: a run
whose ticket never cycles never times out — queue starvation is now admission's
problem to report, not the timeout's to mask. Time spent *running* after the
queue is still billed against the moved deadline, so the cap is moved, not
removed.

`startedAt` on the result still records launch time, so a reader can see the
queue wait as `first agent start − startedAt` when it matters.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — `time queued behind another run's ticket does not count against the run timeout`
  and `post-queue work time still counts against the moved deadline`.

Proved: dropping `excludedTime` from the `runScriptHost` call made the first
test report `aborted` instead of `completed` (the run died at its raw 300ms
deadline while still parked). Counting only drained intervals — the closed
total without the open one — failed the same way, which is why the accumulator
is a live getter. Both were restored.
