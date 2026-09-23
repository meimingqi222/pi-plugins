# Agent Note: Close the await windows in the goal lifecycle

Status: implemented

## Problem

An independent read of `plugins/goal` (a workflow agent, then my own reading of
the cited lines) found eight soft spots. Five were real defects, and all five are
the same species: a lifecycle handler awaits, and the user does something in that
window.

1. **`refreshPlan` wrote through a stale closure.** It read the plan file and then
   assigned `goal.planStep`. The read is an await, and `/goal clear` sets the
   module-level `goal` to `undefined` — so a clear landing in that window made the
   assignment a `TypeError` thrown out of whichever handler called it. It sits in
   `verify()` *outside* its own `try`, and in `agent_start`. A `/goal replace` in
   the same window was quieter and worse: the old goal's plan was attributed to
   the new goal.
2. **A replaced goal's planner kept running and was billed to nothing.**
   `startPlan` created an `AbortController` that no code path ever aborted, and
   `invalidate()` did not know about it. `/goal replace` mid-planning left the
   call running to completion; because `goal.used += usage` sits *after* the goal
   id check, the tokens were then dropped entirely — the cost was paid and
   recorded nowhere.
3. **The budget was enforced only at boundaries.** `budgetReached` ran in
   `schedule`, `startPlan` and `verify`. A work run that reported 60k tokens
   against a 10k budget stayed `active` until it settled, so a long tool loop
   overshot by an unbounded amount with nothing visible.
4. **A failed snapshot took the handler down.** `finish` persists via
   `checkpoint()` before it reports, so a throw from `appendRunSnapshot` (a full
   disk, a session being replaced) escaped the command handler and skipped the
   status bar, the notification and the reason — leaving a goal that had changed
   in memory and not on disk.
5. **The stall fingerprint's temp-path list was machine-specific.** `nextActionKey`
   folded `/tmp`, `/private/tmp` and `/var/folders`. A per-attempt path anywhere
   else — a session-dir evidence file, a build directory, a per-attempt log —
   kept the fingerprint unique, so an identical request looked like new work every
   round, the stall guard never fired, and only the run cap stopped the goal.

The read also reported that `verify()` re-checks `goal.status` after an await but
not `goal.id`, that usage dedup could double-count, and that
`boundedTranscript`'s clip test never exercised the clip branch.

## Decision

**The goal id is captured before every await and re-checked after it.**
`refreshPlan(goalId)` takes the id as a parameter, re-checks it after the read,
and returns `undefined` instead of writing to a goal that moved; `verify()`
captures `goalId` before its first await and re-checks it in the same expression
that already re-checked `flight` and the status. `startPlan` re-checks after its
`writeFile` too, so a cleared goal does not leave a plan file attributed to it.

**The planner is cancellable, and `invalidate()` owns it.** A `planFlight`
record joins `flight`, and `invalidate()` aborts both. A superseded planner's
spend is genuinely unreachable — the goal it belonged to no longer exists, so
there is nothing to bill — which is exactly why the abort matters: it stops the
request instead of paying for a result nobody can use.

**Accounting enforces the budget.** `account()` now calls `budgetReached(ctx)`
the moment a message's usage is known, and aborts the run **only when the plugin
started it** (`owner.continuationDriven`). A user turn is the user's output; the
goal simply stops being active, which is the same rule `/goal pause` follows.

**Persistence failures are reported, not propagated.** `checkpoint()` catches,
records the failure, and `display()` reports it once per streak — one
notification per problem rather than one per boundary. The in-memory goal stays
authoritative and the next boundary retries the write.

**Message identity is checked three ways, strongest first.** The same object
(`WeakSet`), then the provider's response id, then the serialized bytes. The
harness hands the same stored message to both `message_end` and `agent_end`, so
the object check is the one that matches reality; the byte hash only catches it
while no field differs between the two events.

**Any absolute or home-relative path folds, not just the temp directories.**
Paths become one token, so a citation of *different* files still differs by its
surrounding words while a per-attempt scratch path cannot make the same request
look new. Relative paths are deliberately untouched: `fix src/a.ts` and
`fix src/b.ts` are different work.

**The clip branch gets a test that reaches it.** The old test put the oversized
entry *first*, so the walk filled the budget from the end and stopped before
reaching it — the assertion passed without running the code it named. It is now
split into the elided case (oversized oldest) and the clipped case (oversized
newest).

## Consequences

A clear, replace or tree switch landing in any of these windows is now a no-op
instead of a crash or a misattribution. A budget is enforced at the granularity
of one assistant message rather than one run, so a goal-driven run is stopped
when the overshoot is observed, and the worst case is bounded by the message in
flight rather than by the whole loop. A goal whose snapshot cannot be written
keeps working and says so. A stalled goal can no longer be kept alive by a
per-attempt path in its own nudge.

## Alternatives considered

**Capture the goal in a local at the top of each function and never read the
closure again.** Cleaner in principle, but it changes what `/goal pause` does
mid-handler: the handler would keep working with a goal the user just paused.
Re-checking the id keeps the module-level variable authoritative for every
decision, which is what the rest of the plugin assumes.

**Make `refreshPlan` throw and let the callers catch.** The callers have no
better answer than "abandon the round", and `verify()`'s catch would report it as
a verification failure — a pause with a misleading reason.

**Billing a superseded planner to the replacement goal.** It was spent on the old
objective, and attributing it to the new one would make a fresh goal look
over-budget for work it did not request.

**Enforce the budget only at `agent_end`.** Still one boundary too late: a
long tool loop can spend the overrun between the first assistant message and the
end of the run, which is exactly the case that motivated the change.

**Fold every path including relative ones.** Simpler rule, but it collapses
"fix src/a.ts:41" and "fix src/b.ts:77" into one fingerprint, which would make
genuine progress look stalled — the opposite failure, and the worse one.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — "clearing during the plan read does not
  throw out of the handler"; "replacing a goal while the planner runs cancels the
  planner" (the signal, the stale plan not being attributed, and the second call);
  "a plan path squatted by a symlink is refused, not written through"; "a mid-run
  report that exhausts the budget flips the goal there"; "the same message object
  delivered twice is counted once even if it changed"; "a snapshot that cannot be
  persisted does not take the handler down".
- `plugins/goal/test/state.test.ts` — "a per-attempt path outside the temp
  directories folds too"; "a relative path is not a scratch path".
- `plugins/goal/test/verifier.test.ts` — "an oversized oldest entry is elided
  rather than clipped" and "an oversized newest entry is clipped rather than
  dropped", the second of which is what the old single test claimed to cover.

Proved: each red-run below reverted the fix and made exactly that test fail.

- `refreshPlan`'s post-await guard changed from `if (!goal || goal.id !== goalId)`
  to `if (goal && goal.id !== goalId)` → "clearing during the plan read" fails
  with a `TypeError` out of `agent_start`.
- `planFlight?.abort.abort(...)` deleted from `invalidate()` → "replacing a goal
  while the planner runs" fails on `signals[0].aborted`.
- The `budgetReached` call in `account()` disabled → "a mid-run report that
  exhausts the budget" fails with `active` instead of `budget_limited`.
- The `planPathIsSafe` guard disabled → "a plan path squatted by a symlink" fails
  with the outside file rewritten.

Full workspace: 730 pass, 0 fail (goal suite 82 → 98); typecheck clean on every
package; the regression-notes verifier accepts this tree.
