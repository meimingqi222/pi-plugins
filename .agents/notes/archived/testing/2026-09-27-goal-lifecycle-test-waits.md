# Agent Note: Goal lifecycle tests must wait for the deferred verification round

Status: implemented
Archived: 2026-09-29
Superseded-by: 2026-09-29-goal-settlement-test-synchronization.md

## Problem

`plugins/goal`'s suite failed on nearly every run, with a different set each time:
three consecutive runs in this environment failed 28, 16 and 18 tests, and eight
tests failed in all three. The same file could pass a subset of them on a fast
run, which is what made it look like general flakiness rather than a bug.

One cause, in the tests. `agent_settled` does not verify synchronously — the
handler hands the round to a macrotask on purpose ("Pi awaits extension handlers
in registration order. Yield so later synchronous handlers can deliver
follow-ups before we verify"), and the round then reads the plan file and awaits
the verifier before it does anything observable. Almost every test emitted a
settle and read the goal straight afterwards:

```ts
await endWork(env);
expect((await state(env)).status).toBe("paused");   // still "active" or "verifying"
```

Whether that passed depended on how many macrotasks the test's own microtask
chain happened to yield before the assertion — timing, not behavior. It also
silently weakened tests that did pass: a test reading the count of verifier calls
before the round ran asserts `0` for the wrong reason, and a three-round stall
test that only waits for a value the first round already produced proves nothing
about rounds two and three.

Two things kept this invisible. The repository's own gate could not finish —
`pi-subagent` and `pi-agent-runner` each had a test file that never returned (see
`2026-09-27-wait-deadline-timer-livelock.md`), so `bun run test` never reached
`pi-goal`. And a race that passes on a fast machine, plus a suite nobody can
complete, is indistinguishable from a suite that works.

## Decision

The tests wait for the round's product instead of for a tick, and the shared
helpers make that the path of least resistance:

- `endWork(env, messages, until)` and `round(env, messages, until)` take the
  state the caller is about to assert and wait for it, bounded at 100 macrotasks,
  failing with `condition not reached; last state: …`.
- `scheduledRound(env)` is the one-round helper for a *failed* verdict, whose only
  product is the continuation it schedules. Waiting on `env.sent` growth is what
  makes the multi-round stall tests prove every round was processed rather than
  just the first.
- `drainRound()` is the escape hatch for assertions that are genuinely negative —
  "the verifier was not called", "nothing further was billed", "a stale run was
  not verified". A non-event cannot be waited on; the helper gives the round a
  bounded number of macrotasks and says so in its comment. It is the only
  remaining tick-counted wait in the file, and its doc names every use it is for.

All 28 `agent_settled` sites were audited, not just the failing ones. Every site
that read a post-round state without waiting was fixed — a final pass of the same
audit reports none left — including tests that had been passing only because this
machine is fast: `the verifier sees a pending claim and a required action as
different fields` (read `captured[0]` before round 1 existed) and `checking a box
advances the step the next run is given` (read the continuation before it was
scheduled).

No source file changed: the plugin's behavior already matched what the tests
intended, so every failure was the test reading a state the round had not written
yet. The two decisions the affected tests defend are recorded elsewhere —
pause on verification errors (`2026-09-21-goal-verification-lifecycle.md`) and
the bounded continuation loop (`2026-09-21-goal-continuation-unbounded.md`).

## Alternatives considered

**Make the deferral awaitable so tests can await the round.** Rejected: the
deferral is a recorded scheduling decision, and a test-only hook that made it
awaitable would either change production ordering or add a second code path whose
only user is the suite. A `queueMicrotask` deferral was also considered and does
not help: the round's own awaits still span macrotasks, so a test would still have
to wait for an outcome.

**Wait a fixed number of ticks everywhere (`await tick()` → `await ticks(8)`).**
Rejected: that is the "guessing a tick count" the file's own comment warns about.
It passes until the round gets slower — a new test, a slower machine, a
file-parallel run — and then flakes again with no diagnosis. A predicate wait
fails with the state it saw.

**Fix only the tests that were red.** Rejected. The audit found eight more sites
reading through the same race; they pass because this machine is fast, and they
would have been the next unexplained flake.

**Assert the plugin's internal flight state by exporting it.** Rejected: it
inverts the contract — the tests would assert that a round is in flight rather
than what the round produced, and it adds public surface for the suite's benefit.

## Consequences

The suite is deterministic: thirteen consecutive full runs report 133 pass / 0
fail, having failed 4–28 tests per run before. Failures now name the state that
was reached instead of showing an off-by-one count.

The helpers grew a parameter, so a new test that forgets it can still race; the
mitigation is that `until` is the obvious place to write the expectation, and
`endWork`'s doc states what happens without it. `drainRound` remains bounded by a
count because a negative assertion has no other form, and it is documented as
such rather than left as a bare `await tick()`.

The deeper lesson is about the gate, not this file: while the repository-wide
suite could not complete, an entire plugin's red tests were invisible. The
livelock fix is what made this suite reachable, and this note is what it found.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — the whole file, green on thirteen
  consecutive runs; the audited sites are the tests whose waits this note
  describes, including `a goal-terminated tool batch leaves its candidate ready for
  verification`, `a clean candidate survives a background follow-up and verifies
  without a second report`, `a queued follow-up invalidates a verdict before its run
  starts`, `provider rejection pauses instead of completing` and `work run cap
  pauses before paying for another verification`.
- `plugins/goal/test/background-combination.test.ts` — the cross-plugin cases,
  which use their own `until` polling helper and were already awaiting the
  deliveries they assert.

Proved: before the wait changes, three consecutive runs of `bun test` in
`plugins/goal` failed 28, 16 and 18 tests (with different sets each time), and the
isolated single test `provider rejection pauses instead of completing` failed with `Expected: "paused", Received: "active"` while the plugin
under test had in fact paused the goal — instrumenting `finish()` showed the pause
happening after the assertion. After the change: 8/8 runs green at 133 pass, 0
fail, and the full repository suite (`bun run test`) reaches `pi-goal` and passes
it.
