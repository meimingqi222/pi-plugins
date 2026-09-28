# Agent Note: A writer queued on the writer lock must not hold a concurrency slot

Status: implemented

## Problem

`runWorkflow`'s agent dispatch acquired the concurrency semaphore first and
the single-writer lock second. With `maxConcurrency` N, a panel of `developer`
agents could park N−1 of them inside semaphore slots while they waited on the
writer lock — doing nothing — and every read-only agent behind them starved
until a running writer finished. The locks were ordered for exclusivity
(two writers never overlap) but the order conflated two different resources: a
slot means "this call is running", the writer lock means "this call may edit".

## Decision

**Take the writer lock before the concurrency slot.**

Dispatch is now `isWritingRole ? writerLock.run(withSlot) : withSlot()` where
`withSlot` does `semaphore.acquire(); try { invoke() } finally { release() }`.
A writer queued on the lock holds no slot, so a `researcher` behind two
`developer`s in a `maxConcurrency: 2` panel starts while the second writer is
still waiting. Read-only agents are untouched — they never touch the writer
lock. Exclusivity is unchanged: the lock still wraps the entire `runAgent`
call, retries included.

## Alternatives considered

- **Keep the order, raise the ceiling.** The starvation is structural, not
  numeric — any finite ceiling admits a panel of writers that fills it.
- **Acquire the slot only inside `runAgent`.** Equivalent effect but moves the
  semaphore's reason for existing (bounding the executor's concurrency) into
  the runner, away from the budget/admission bookkeeping it sits next to.
- **Order locks globally (writer lock then semaphore) for all agents.** That
  is what was done, restricted to writers — readers skip the lock entirely, so
  they cannot deadlock on a lock they do not take.

## Consequences

Panels mixing writers and readers no longer degrade to serial-execution-plus-
starvation. A lone writer still blocks second writers exactly as before — the
test suite's "two declared writers never hold the workspace at once" pins
that. One subtlety: a writer now occupies a semaphore slot only while actually
running, so `maxConcurrency` bounds *running* calls, not *admitted* ones —
which was always the intent.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — "a writer queued on the
  writer lock does not hold a concurrency slot": developer A blocks on a
  manual release while holding the writer lock, developer B queues behind it,
  and reviewer C must start while A is still running.
- The neighbouring writer-exclusivity and reader-concurrency tests pin that
  the reorder did not change what the locks protect.

Proved: with the fix reverted (semaphore acquired before the writer lock),
the new test fails — C never starts within the window because B holds the
second slot while parked on the lock (`29 pass, 1 fail`, ~2s poll timeout).
With the fix, `bun test plugins/workflow/test/orchestrator.test.ts` reports
30 pass, 0 fail.
