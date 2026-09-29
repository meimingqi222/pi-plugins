# Agent Note: Await goal settlement in tests instead of sleeping ten milliseconds

Status: implemented

## Problem

The lifecycle test harness called pi-goal's `agent_settled` handler and then
slept a fixed 10ms before returning. The handler deliberately defers settlement
with `setTimeout(0)` to let later extension handlers queue follow-ups; its
settlement can also await plan I/O and a verifier model. Under event-loop load,
10ms can expire before verification finishes. Tests that immediately checked a
verifier call count or terminal status then failed despite settlement eventually
completing. Increasing the delay would only change the probability of failure.

A previous congested-loop probe saw an early assertion miss followed by a
completed goal one tick later. That demonstrates a timing-sensitive assertion,
**not** that the implementation can never have a separate concurrency bug.

## Decision

Make the plugin's next-turn settlement scheduler injectable, retaining the
original `setTimeout(0)` as its production default. The lifecycle fixture uses
the same next-turn timer but tracks a promise for the *entire* scheduled
settlement, including asynchronous verification. Its regular `emit` awaits
that promise; `emitRaw` leaves the ordering window open for tests that simulate
later `agent_settled` handlers and can explicitly await the captured settlement
after injecting a follow-up. Neither path guesses a duration.

The fixture does **not** globally fake timers or wait for a vague "quiescent"
state: a verifier can intentionally remain pending while a test cancels it or
starts a follow-up. In those tests, `emit` is started without awaiting it,
interleaving actions occur, and only then does the test await its completion.

## Alternatives considered

- Increase the 10ms sleep: remains timing-dependent, slower and less reliable.
- Poll the expected status or verifier call count only in failing tests: fixes
  positive assertions, but does not make negative assertions ("not verified")
  meaningful without knowing the scheduled callback has actually run.
- Await the timer from pi-goal's event handler: Pi awaits extension handlers in
  registration order, so this would prevent later handlers from delivering
  their follow-ups before verification, changing the production contract.
- Globally replace `setTimeout` in the test: interferes with unrelated timers,
  other extensions and test files.

## Consequences

The production handler still returns immediately and still settles on the next
event-loop turn; only tests receive a completion signal for that scheduled
work. The lifecycle fixture now awaits slow verifier calls instead of returning
at an arbitrary deadline. The test that starts a follow-up after `emitRaw`
explicitly awaits the *old* settlement before asserting it did not verify.
Other asynchronous work, such as a later continuation or a delegation's
microtask settlement, remains separately observed by the tests that exercise
it; this change does not claim to prove the absence of unrelated runtime races.

## Verification

- `plugins/goal/test/lifecycle.test.ts` contains the bound lifecycle regressions.
- `plugins/goal/test/lifecycle.test.ts::agent_settled waits for a slow verifier instead of a fixed timer` pins the fixture's synchronization contract: a simulated slow verifier must have finished when a regular `agent_settled` emit returns.
- `plugins/goal/test/lifecycle.test.ts::another settled handler can start a follow-up before verification begins` pins the distinct raw ordering window and waits for its actual scheduled callback, not a 15ms delay.
- `plugins/goal/test/lifecycle.test.ts::a goal-terminated tool batch leaves its candidate ready for verification` pins the original assertion that intermittently saw an incomplete settlement.

Proved: replaced the new fixture's `await awaitSettlement()` with the old
`setTimeout(resolve, 10)` and ran the first bound test: exit 1, expected
`"complete"`, received `"verifying"` (1 fail). Restored the await: the same
lifecycle test file passes (96 pass, 0 fail); the full workspace typecheck,
tests, and notes gate were run after the change.
