# Agent Note: Close the run registry with a grace window

Status: implemented

## Problem

`RunRegistry.reset()` was the leave-session path: abort every active run, clear
the active map, clear the settled history. It freed the run slots immediately,
which was the point, but it also forgot the work:

- an executor that ignored its abort kept a child process and its provider
  ticket alive with nothing in the registry tracking it;
- a cooperative run that settled a few milliseconds after the abort had its
  `settle()` discarded (`active.delete(runId)` returned false), so there was no
  record that it ever finished;
- nothing reported the difference between "stopped" and "we stopped waiting".

The reference agents separate these: ZCode's run service `close()` aborts live
runs and **awaits their settlement promises**, so shutdown is bounded and the
terminal state is recorded rather than orphaned.

## Decision

Replace `reset()` with `close(graceMs = 5_000): Promise<CloseResult>`.

- Active entries move to a `closing` map and their controllers are aborted
  **synchronously**; `active` is cleared at once, so a new session can launch
  immediately and the run-slot ceiling is not held by the old session.
- Every entry carries a `done` promise resolved by `settle()`. `close()` waits
  on all of them, or on a `graceMs` timer, whichever comes first.
- A run that settles inside the window is recorded as settled; a run that does
  not is marked `aborted` with an explicit message, removed from `closing`, and
  reported in `abandonedIds`. `leaveSession` logs the abandoned ids.
- Closing runs do **not** fire `onSettled`. The owning session is gone, and the
  plugin released its goal leases and delivery origins at the same boundary; a
  late callback would be a second report, not a recovery.
- A late `settle()` after abandonment finds no entry and is a no-op.
- `close()` is idempotent while it is waiting, and the timer is unref'd so a
  one-shot process is never held open by a graceful shutdown.

`stop(runId)`, `stopAll()` and `settle()` for active runs are unchanged: a user
stop is still a request whose result is delivered normally.

## Alternatives considered

**Keep reset and only log orphans from the executor.** The registry has no
visibility into a child that outlives its abort; the plugin would have to poll
its own executor, and every executor would need the same logic.

**Await without a grace window.** One uncooperative provider would block session
switching forever. The grace window is what makes the wait a shutdown bound
rather than a hostage situation.

**Fire `onSettled` for closing runs.** It would report to a session that no
longer exists, after its leases were already finished, and could deliver into a
cleared origin map. The boundary already has an explicit owner for that cleanup.

**Clear `closing` immediately and lose the promise.** That is the old behavior
under a new name: settlement becomes unobservable and the abandoned count cannot
exist.

## Consequences

Leaving a session now takes at most the grace window *in the background*; it
does not block the switch. The visible new information is the abandoned count
and its run ids. A cooperative run that finishes just after the abort is recorded
as settled instead of silently discarded.

Tests that leave a session with a deliberately abort-ignoring executor now keep
a closing entry until the grace timer fires; the timer is unref'd, so it does
not keep the test process alive.

## Verification

- `plugins/workflow/test/registry.test.ts` — four `RunRegistry close` tests:
  cooperative settlement inside the grace, abandonment after it, launching
  during a close, and idempotence.

Proved: removing the `closing` branch in `settle()` made
`frees slots at once and reports work that settles inside the grace` resolve as
`settled: 0, abandoned: 1` instead of `settled: 1, abandoned: 0` (`1 fail`).
Removing the forced-abandonment settlement made
`records work that ignores abort past the grace instead of losing it` leave
`close()` pending indefinitely (the test did not finish). Both were restored.
