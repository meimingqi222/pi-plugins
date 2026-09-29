# Agent Note: An awaited wait deadline is not an unref'd timer

Status: implemented

## Problem

`LaneRegistry.waitFor` ended a wait with `setTimeout(..., deadline)` and then
called `unref()` on that handle. The intent was "a wait nobody is watching must
not hold the process open". The effect was that the only thing able to end a wait
on a lane that never settles was a timer the process had declared it would not
stay alive for.

On Bun 1.3.14 / Windows that combination does not degrade gracefully: when the
waiting promise is the only pending work, Bun neither runs the unref'd timer nor
exits. It spins at 100% CPU, forever. A two-line reproduction with no plugin code
in it:

```ts
await new Promise((resolve) => {
  const t = setTimeout(() => resolve(0), 0);
  (t as { unref?: () => void }).unref?.();
});
```

Measured on the real path: the process burned ~100 s CPU over ~100 s wall time
and never settled the wait. `bun test --timeout` cannot preempt it either — a
timer-driven timeout needs the loop, and the loop is what is blocked.

The blast radius was the repository's own gate. `plugins/subagent/test/plugin.test.ts`
contains the first test that waits on a running lane with `timeout: 0`, and its
stub executor is a bare promise with no handle behind it — exactly the "nothing
else pending" shape. That file never finished, so `pi-subagent`'s `bun test`, the
root `bun run test`, and the pre-push hook that runs it hung on this machine
indefinitely. It reads as a slow suite rather than a bug, which is why it
survived: the process is alive and burning CPU, not blocked on I/O.

`pi-agent-runner` had the same shape twice over, in both transports. The
wall-clock deadline (`setTimeout`) and the silence bound (`setInterval`) that end
a run were unref'd in `src/executor.ts` and `src/rpc-child.ts` — and a run is
exactly something the caller awaits. `plugins/agent-runner/test/rpc-child.test.ts`
hung the moment it reached the stall-bound case (it got as far as "send() refuses
after the run is finished"), which is why the root `bun run test` stopped at
`pi-agent-runner` after the subagent fix and never reached the packages behind it.
`src/executor.ts` even carried the intent in a comment — "so a one-shot run is
not held open by a timer nobody can see" — while the run's own caller was waiting
on precisely that timer.

## Decision

Every timer that is the only thing able to end an awaited operation is no longer
unref'd:

- `LaneRegistry.waitFor`'s deadline timer (`plugins/subagent/src/lane.ts`) — a
  caller blocked on this promise is a reason for the process to stay alive,
  which is the entire point of a `wait`.
- A run's wall clock and silence bound in both `pi-agent-runner` transports
  (`src/executor.ts`, `src/rpc-child.ts`) — a caller awaits `done`, and those two
  timers are what end it. Each is still cleared in `finish()`, so a settled run
  holds nothing open.

The distinction that keeps the original intent intact: **unref belongs to timers
nobody awaits, and only to those.** The idle keep-alive that eventually closes a
background RPC child (`plugins/subagent/src/index.ts`, `keepAliveMs`) stays
unref'd, because a fire-and-forget caller must not be held open by it — that is
the case the original `unref()` calls were written for. So does the `taskkill`
spawn in `killAgentTree`, and the `child.unref()` in `finish()`.

A wait nobody is watching is still bounded without `unref`: the tool call's own
signal aborts it, and `waitFor` returns "interrupted" rather than parking on a
deadline. A run nobody is watching is bounded by its own deadline timer, which is
now simply allowed to fire.

## Alternatives considered

**Fix the test instead: give the stub executor a handle that keeps the loop
scheduled.** Rejected as the fix. It removes the symptom and leaves the wait
itself unable to end in the one situation where the timer is the only thing
pending — the harness would then be the only reason the bug stayed invisible,
which is how it was introduced.

**Resolve `timeout: 0` synchronously without creating a timer.** Rejected: it
narrows the fix to the test's exact call. Any non-zero deadline with no other
pending handle still livelocks, and `timeout: 0` would then not exercise the
timer path at all.

**Unref only when the deadline is long.** Rejected: a magic threshold decides
whether a wait can end, and the failure mode (100% CPU spin) is far worse than
the thing the threshold protects against.

**Report it upstream and keep `unref`.** Not sufficient on its own. The Bun
behaviour is worth reporting — the process ignoring its own timers *and* refusing
to exit is not a defensible reading of `unref` — but a promise here should not
depend on that being fixed, and `node`-shaped semantics do not make the wait
resolvable either.

## Consequences

A live wait or a live run now keeps the process alive until its own deadline
(5 minutes at the default cap for a wait) even if the caller has stopped caring.
That is bounded by the tool-call signal and by `cleanup`/`finish` on settle or
abort, and it is strictly better than a wait that can never end.

The package's own suite went from never finishing to `109 pass, 0 fail` in about
1.4 s, and `pi-agent-runner` from a file that never finished to `64 pass, 0 fail`
(8 POSIX-only cases skipped) in about 10 s. The root `bun run test` now runs
`ace-search` (71), `agent-runner` (72) and `bg-bash` (107) to completion and stops
only at `pi-goal`, whose suite fails 4–10 tests nondeterministically on this
machine with or without these changes (A/B: 10 then 4 failures with the change,
6 then 9 without). That flake is its own defect and is not part of this decision;
it is fixed by `2026-09-29-goal-settlement-test-synchronization.md`.

## Verification

- `plugins/subagent/test/lane.test.ts::the wait deadline's timer keeps the event loop alive` — installs a `setTimeout` spy around one `waitFor` call on a running lane and asserts the deadline handle's `hasRef()` is not `false`. It reads the handle rather than waiting for the deadline on purpose: any ref'd timer elsewhere in the test would schedule the loop and mask the bug, which is precisely how it stayed hidden.
- `plugins/agent-runner/test/rpc-child.test.ts::the run's deadline and silence bound keep the event loop alive` — the same assertion for the RPC transport, counting that the two bounds are the only timers the path creates.
- `plugins/agent-runner/test/executor.test.ts::the deadline and silence bound keep the event loop alive` — the same for the JSON transport, waiting through the real timers for the bounds to be armed after the run's own setup awaits.
- `plugins/subagent/test/plugin.test.ts` — the whole file, which used to run forever, now finishes: 25 pass, 0 fail in ~1 s.
- `plugins/agent-runner/test/rpc-child.test.ts` — the whole file: 12 tests in ~1.6 s, where the stall-bound case previously never returned.

Proved: with `(timer as { unref?: () => void }).unref?.()` restored in `waitFor`, the new test failed in 0.74 ms (`Expected: not false`) while the rest of the file passed, and `plugins/subagent/test/plugin.test.ts` again failed to finish within a 100 s timeout (`rc=124`). With `unref` removed: `bun test` in `plugins/subagent` reports 109 pass / 0 fail.

Proved: with `stallTimer?.unref?.()` restored in both `pi-agent-runner` transports, the two new ref-state tests failed in 22 ms and 2 ms (`0 pass, 2 fail`) instead of hanging, and the whole-file run of `plugins/agent-runner/test/rpc-child.test.ts` was again killed at 45 s (`rc=124`). With the `unref` calls removed: 64 pass / 0 fail.
