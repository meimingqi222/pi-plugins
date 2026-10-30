# Agent Note: Bound the workflow semaphore, run listing and Morph upload

Status: implemented

## Problem

Three follow-ups from review, each small, each with a concrete failure:

1. **The workflow semaphore allowed barging.** `release()` decremented `active`
   and then woke a waiter, which incremented only after its microtask resumed.
   In that window a fresh `acquire()` saw a free slot and took it, so two
   callers could hold one permit — with `maxConcurrency: 1`, two agents briefly
   in flight holding two provider tickets.
2. **`listWorkflowRuns` read every journal.** It looped all run directories and
   only sliced to `limit` afterwards, so `/workflows` on a project with two
   hundred runs read hundreds of megabytes of `journal.jsonl` on every
   invocation.
3. **Morph compaction uploaded unredacted with no redactor installed.**
   `redactor.redact()` returned its input unchanged when the bus carried no
   service, so enabling `compact` on a machine without `pi-redact` sent the
   whole {{SECRET_l6neygg}} — secrets included — to Morph. `pi-permissions`
   already fails closed for the same upload shape.

## Decision

**The semaphore transfers the slot instead of freeing it.** `release()` shifts a
waiter and returns without touching `active`; only a release with nobody waiting
decrements. The waiter's `acquire` no longer increments after its await, because
the permit arrived with the wake-up.

**The listing reads a bounded window.** Directories are stat'ed — one cheap
`stat` each, no journal opened — sorted by mtime descending, and only
`max(limit * 4, limit + 16)` journals are read. The window is a multiple of
`limit` rather than `limit` because the final order is `startedAt` and a
directory's mtime can lag the run it holds: a long run writes early and goes
quiet, a short one writes once at the end. The margin absorbs that reordering.
This is a listing of recent runs; a run old enough to fall outside the margin
was already outside the page.

**The Morph upload fails closed on an absent redactor.** `installRedactBridge`
now reports `available()`, and the compaction hook returns early — falling back
to pi's own summariser — when no service answered, warning once per session. A
**paused** redactor is treated differently and allowed through: `isEnabled()`
returning false is the user's explicit choice, and blocking there would override
a decision they made on purpose. Only absence is an unexamined gap.

## Alternatives considered

- **Semaphore: keep the decrement, make `acquire` re-check.** Rejected: the
  re-check is the barging window. Transferring the permit is the standard fix
  and needs no second check.
- **Listing: read only `limit` journals.** Rejected: mtime order is not
  `startedAt` order, so a tight window silently drops runs that belong on the
  first page.
- **Listing: add a `progress.json` with a timestamp.** Rejected for now: the
  journal is the durable record and a second status file is a second thing that
  can disagree — the very problem `readRunSummary`'s comment says it avoids.
- **Morph: fail closed on a paused redactor too.** Rejected: that overrides an
  explicit user choice, which is a different kind of wrong.
- **Morph: warn and upload anyway.** Rejected: that is the defect.

## Consequences

- A workflow that legitimately exceeds its concurrency cap is now refused rather
  than briefly over-admitted.
- `/workflows` cost is bounded by the window, not by the number of runs ever
  made. On a project with few runs the behaviour is unchanged.
- Enabling `compact` without `pi-redact` now produces pi's default compaction
  plus one warning, instead of an unredacted upload. Users who want the upload
  must install the redactor.

## Verification

- `plugins/workflow/test/progress.test.ts` — `listing reads a bounded window,
  not every journal` makes the journals outside the window unreadable (a
  directory where a file is expected), so reading one throws; `a long run that
  wrote early still lists before a short recent one` pins that `startedAt`, not
  mtime, decides the order.
- `plugins/morph-search/test/plugin.test.ts` — `compaction without a redactor
  does not upload the {{SECRET_l6neygg}}` and `a paused redactor still allows the
  upload the user asked for`.
- `plugins/morph-search/test/compact-boundary.test.ts` — three tests that drove
  the hook through `setup()` with no service now pass one, because without it
  they are correctly blocked before the request starts. One of them failed as a
  5 s timeout rather than an assertion, which is the useful shape of this
  failure: the upload never happened, so the promise it was waiting on never
  settled.
- Red-run proof: `regression-evidence/workflow-list-window-red.txt` — restoring
  `const window = entries.length;` makes the bounded-window test fail with
  `EISDIR` on the journal it should never have opened.

Proved: Proved: `regression-evidence/workflow-list-window-red.txt` — with `const window = entries.length;` restored in `listWorkflowRuns`, `plugins/workflow/test/progress.test.ts::listing reads a bounded window, not every journal` fails with `EISDIR` on the `plugins/workflow/src/runs/journal.ts` reader, on a run directory whose journal it should never have opened. The Morph upload test fails the same way without the `available()` guard: the request is recorded and the payload leaves.
