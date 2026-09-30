# Agent Note: Deliver background results at Pi's settled boundary

Status: implemented
Partly-superseded-by: 2026-09-30-subagent-result-consumption-and-turn-delivery.md

The bg-bash delivery portion is also superseded by
`2026-09-30-bg-bash-result-consumption-and-turn-delivery.md`: it now owns a
query-consumable pending map, submits native steering at turn_end, and keeps
agent_settled as the late-result fallback. It no longer uses
SettledDeliveryQueue. The historical decision below still documents the
original fix; it is not a ban on native active-run delivery.

## Problem

`pi-bg-bash` and `pi-workflow` held completed results in private queues while
`ctx.isIdle()` was false, then retried only on `agent_end`. A completion could
arrive after the last `agent_end` but before Pi emitted `agent_settled`; no
later `agent_end` would wake the private queue. The queue was also invisible
to `pi-goal`, allowing a fast verifier to judge a transcript before a pending
background result was delivered. A failed goal spend callback could separately
prevent workflow result delivery or session cleanup.

## Decision

After checking the originating session, both extensions send idle results
immediately. A result produced during an active run waits for `agent_settled`,
then calls `pi.sendMessage` with `deliverAs: "followUp"` and `triggerTurn: true`.
The short pending queue is cleared on session leave and is never drained at
`agent_end`. They retain synchronous delivery error reporting. Workflow goal
spend failures remain isolated from result delivery and cleanup.

The settled-boundary queue now lives in pi-run-core as SettledDeliveryQueue and
is consumed by bg-bash, workflow and subagent. Origin checks and message policy
remain local. A subagent previously sent directly in the final queue-check gap;
its result could remain queued without a new run to consume it. Subagent now
also clears queued sends on navigation and rechecks the origin at delivery.

## Alternatives considered

**Wait for `agent_end` and recheck idle.** Pi remains busy until
`agent_settled`, so a result arriving in that gap could miss the final wake-up.

**Poll `isIdle()` on a timer.** That duplicates Pi's scheduler, adds polling to
long runs, and still leaves a private message invisible to goal verification.

**Send blindly at any point while a run is active.** Pi supports native
steering and follow-up messages during an active run. The race is narrower:
a result entering the native queue after the final queue check but before
`agent_settled` can miss the last wake-up. That gap justifies a settled
fallback, not a blanket prohibition on active-run delivery. A `turn_end`
handler can enqueue steering before the loop's next queue check.

**Treat goal spend failure as a workflow result failure.** The result already
exists; accounting failure should be reported separately.

## Consequences

Pi starts a follow-up at the idle boundary. A result produced after a session
leaves remains suppressed by the origin guard. A follow-up already handed to
the old Pi runtime is governed
by its session teardown. A synchronous send failure is reported through the
originating UI; Pi reports asynchronous send failures through its runtime
error channel.

## Superseded

The shared settled-boundary primitive and its use by workflow still hold.
Subagent now uses a revision-aware queue: unread results steer at the parent's
`turn_end`, with `agent_settled` retained as a late-arrival fallback. Queries
returning the canonical answer consume the pending result. See the successor
note for the source audit and real Pi runtime tests. The original all-busy-runs
deferral was a conservative policy, not a transport-layer requirement.

Bg-bash now persists every completion but wakes the model only for
failures, timeouts, or explicit `notify: "always"`; successful default jobs
do not enter this queue. See `2026-09-26-bg-bash-late-completion-routing.md`
for that independent policy. Its
post-`agent_end` wake-worthy completions still use `agent_settled`.

## Verification

- `plugins/bg-bash/test/plugin.test.ts`
- `plugins/bg-bash/test/plugin.test.ts::a completion after agent_end is handed to Pi at agent_settled`
- `plugins/workflow/test/plugin-wiring.test.ts`
- `plugins/workflow/test/plugin-wiring.test.ts::a workflow result after agent_end reaches Pi at agent_settled`
- `plugins/workflow/test/plugin-wiring.test.ts::a failing goal spend lease cannot prevent session cleanup`
- `plugins/goal/test/background-combination.test.ts`
- `plugins/goal/test/lifecycle.test.ts::goal and subagent deliver a late child at settlement before verifying its candidate`
- `plugins/goal/test/lifecycle.test.ts`

Proved: before the first fix, both tests timed out after the last `agent_end`.
After direct native sends, strengthened assertions failed with `Expected length:
0, Received length: 1` before `agent_settled`. Both passed after delivery moved
to that boundary. The existing spend failure tests remained green.

Proved: the goal/subagent late-completion test failed before sharing the queue
with Expected wakeups 1, Received 0. It passes after the fix. Four-plugin tests
exercise both goal registration orders, exact-once delegated spend, delivery
before verification, and discarding all three queued result types on navigation.
