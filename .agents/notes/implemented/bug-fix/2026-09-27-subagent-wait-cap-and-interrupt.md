# Agent Note: Let `wait` block for as long as the contract asks it to

Status: implemented

## Problem

`SUBAGENT_DESCRIPTION` tells the model to inspect a background task with
`subagent_tasks`' `wait` action rather than polling, but `wait` could not
outlast 30 seconds (`WAIT_TIMEOUT_MAX_SECONDS`). Every real delegated task runs
longer than that, so the instruction was unfulfillable: the model asked for 30
seconds, got the task back still running, and polled anyway.

Observed in a real session — two `explore` children stalled on `find`, and the
parent's next six calls were `wait 30`, `wait 30`, `show`, `events`, `cancel`.
The advice and the bound disagreed, and the model followed the bound.

Raising the cap on its own would have traded one problem for a worse one: a
`wait` ignores the tool call's abort signal, so an interrupted 300-second wait
would stay parked on its timer and resolve into a turn that had already moved
on.

## Decision

**Raise the cap to 300 seconds, make the wait end when its own tool call does,
and say which of the two happened.**

- `WAIT_TIMEOUT_MAX_SECONDS` is 300; the default stays 30, so the common case
  still returns promptly and a caller that means to block says so. The parameter
  description is built from the constant, so it follows.
- `LaneRegistry.waitFor` takes an optional `AbortSignal` and resolves
  immediately when it fires, cleaning up both its waiter entry and its timer.
  `subagent_tasks` passes the tool call's signal — which its `execute` was
  already receiving and discarding.
- `waitFor` returns `{ lane, outcome }` with `"settled" | "timeout" |
  "interrupted"` instead of a bare record. All three exits leave the lane
  *running*, so the first version of this fix reported an interrupted wait — one
  that returned in a millisecond — as `Still running after 300s`, stating an
  elapsed time that never happened. Only the deadline branch reports an elapsed
  time now.
- The `waitFor` cleanup is now one function used by all three exits (settle,
  deadline, abort), so the waiter set and the timer cannot drift apart.

A stalled lane does not make the caller sit out the whole window: the stall
bound fails the lane, which settles it, which resolves the wait with a real
outcome.

## Alternatives considered

- **Raise the cap without the signal.** Simplest, and wrong: it makes the
  interrupted case strictly worse than the 30-second one it replaces.
- **Keep 30 seconds and delete the anti-poll sentence from the contract.** Honest,
  but it throws away the only way for a caller to block on a task without
  burning a turn per poll.
- **Return early when the lane is already `stalled`**, rather than waiting out
  the deadline. Tempting, but the stall label is a 90-second hint, not proof —
  a slow provider turn is quiet without being stuck, and returning on the hint
  would make `wait` unreliable exactly when it is most useful.
- **Unbounded `wait`.** A tool call with no deadline cannot be reasoned about by
  the caller that has to budget its own turn.

## Consequences

`wait` now honours the contract that recommended it, up to five minutes, an
interrupt ends it, and each of the three outcomes is reported as itself — the
same rule the `StopOutcome` change applies to cancellation, in the other control
verb.

The cap is still a cap: a task that outlives five minutes returns "still
running", and the caller is expected to do something else and let the
completion message arrive.

## Verification

- `plugins/subagent/test/plugin.test.ts` — "wait clamps to the documented cap and
  returns when its own tool call is interrupted" (an absurd `timeout` returns in
  under a second with an already-aborted signal, and the text says the wait was
  interrupted rather than claiming 300s elapsed) and "wait reports the cap only
  when the deadline actually elapsed" (no signal, `timeout: 0`, so the caller is
  told about the clamp it did wait for).
- `plugins/subagent/test/lane.test.ts` — the existing wait tests still pass,
  which pins that the shared cleanup did not change the settle and deadline
  exits.

Proved: with the `signal` argument removed from the `waitFor` call, the plugin
test fails at its 5000ms timeout — the wait parks on the 300-second timer, which
is the exact regression the signal wiring prevents. With the outcome
distinction removed (one `Still running after…` branch), the interrupted test
fails in 0.89ms on the wording it now asserts. Restoring both turns the tests
green.
