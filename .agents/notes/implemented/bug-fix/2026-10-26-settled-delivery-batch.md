# Agent Note: Isolate each settled delivery

Status: implemented

## Problem

`SettledDeliveryQueue` flushed its pending batch with

```ts
for (const send of this.pending.splice(0)) send();
```

The batch is removed from the queue before any send runs. If the first `send`
throws — a torn-down UI context, a session that moved between the idle probe and
the settled boundary, a message the host refuses — the loop aborts and every
remaining closure, already spliced out, is lost. One result's delivery failure
silently discarded every other result queued behind it.

The contract comment said `send` must handle its own errors, and `pi-workflow`'s
own send does. But a shared queue whose correctness depends on every future
caller remembering a comment is one caller away from the same bug, and the
failure is invisible: the skipped runs look like runs whose delivery never
happened.

## Decision

Wrap each send in its own `try/catch` inside the flush loop. The queue's job is
delivery; a failed send has already had its chance to report to its origin, and
one result's failure must not consume another's.

This also matches what `pi-subagent` and `pi-bg-bash` already do in their own
queues (per-entry `try` around `sendMessage`), so the shared primitive is no
longer the least robust of the three.

## Alternatives considered

**Make `send` fallible and return a result.** Changes every caller for a case
the queue can handle locally, and a caller still has to remember to check it.

**Re-queue the whole batch on throw.** The failed entry would throw again on the
next settled boundary, pinning the queue forever. Only the failing entry should
be lost, and it is the one that already ran.

**Let the exception propagate to Pi's event loop.** Pi may log or swallow it,
but the remaining sends are already gone; the loss is the part that matters.

## Consequences

No API change. A delivery failure is still silent to the queue itself — callers
that want to notify the user keep their own `try/catch` and `notify`, which is
where the origin-specific message belongs.

## Verification

- `plugins/run-core/test/security-accounting.test.ts` — the settled-batch
  isolation test.

Proved: reverting the loop to the bare form made
`one throwing delivery does not drop the rest of the settled batch` fail with
the thrown `origin went away` escaping the handler (`2 pass, 1 fail`). Restored,
the file is `3 pass, 0 fail`.
