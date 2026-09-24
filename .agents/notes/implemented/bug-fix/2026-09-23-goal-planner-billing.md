# Agent Note: goal review fixes — planner billing, verifier evidence split, stale status bar

Status: implemented

## Problem

A read-through of `pi-goal` after the candidatePending fix found three more
defects:

1. **The planner's tokens were never billed.** `startPlan` ran a model call but
   only the verifier's usage was added to `goal.used`. A token-budgeted goal
   paid for planning invisibly, and a small budget could be exhausted by the
   planner without the budget check ever seeing it.
2. **`candidate` in the verifier payload was ambiguous.** The field holds the
   implementer's claim while unjudged, but after a rejection it holds the
   verifier's own `nextAction`. Sent under one name, the next verification
   round could read its own instruction as a fresh completion claim.
3. **The status bar went stale at run end.** `agent_end` checkpointed usage but
   never called `display`, so the token count shown lagged until the next
   boundary.

A consistency fix rode along: `goalPrompt` treated `candidatePending ===
undefined` (legacy snapshots) as judged while the verifier treated it as
pending. Both now use `!== false`, and the "predates the pending candidate"
line only prints when a pending candidate actually exists.

## Decision

- `runPlanner` returns the model response; `startPlan` adds its usage to
  `goal.used` and runs `budgetReached` before parsing and writing the plan,
  so even an invalid paid reply is counted and a planner that exhausts the
  budget stops the goal instead of planning for a dead one.
- The verifier payload splits the field: `candidate` is only the pending
  claim, `requiredAction` carries the previous verdict's demand. The system
  prompt documents that they never appear together.
- `agent_end` calls `display(ctx)` after `checkpoint()`.

## Alternatives considered

**Bill the planner inside the verifier's total.** The planner and the verifier
are separate side calls that happen at opposite ends of a run, and the budget
check sits between them; folding both into one accumulator would make it
impossible to say which call spent what, and would move the check to after the
planner had already run.

**Keep one `candidate` field and disambiguate by prose.** The verifier prompt
would have to infer from context whether `candidate` is the implementer's claim
or its own previous instruction, which is the ambiguity the bug is made of.
Splitting the field makes the distinction structural instead of interpretive.

**Repaint the status bar only at the boundaries that already checkpoint.** That
is the defect: `agent_end` checkpointed usage and returned without displaying,
so the count on screen belonged to the previous boundary.

## Consequences

A token-budgeted goal now sees planning cost, so a budget small enough to be
consumed by the planner stops the goal at planning instead of funding work for a
dead goal. `goal.used` is higher when the first work run starts, which is the
intended accounting rather than a regression.

The verifier payload gained `requiredAction`, so `candidate` now means only "the
pending claim". A consumer that read the old overloading must read both fields.
The consistency fix aligns legacy snapshots — `candidatePending === undefined`
is pending for `goalPrompt` as well as for the verifier — so a goal restored from
an older build is judged the same way it is prompted.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — the "goal candidate verification
  status" suite gained three tests: the verifier payload carries `candidate`
  versus `requiredAction` across two rounds; planner usage lands in `goal.used`;
  the status bar shows settled usage at `agent_end`.

Proved: removing `goal.used += usage` after the planner call failed
`plugins/goal/test/lifecycle.test.ts`'s "the planner's tokens are billed to the
goal" with `Expected: 42, Received: 0`, then passed again after restoring the
line. Full workspace after restoring: 582 pass, 0 fail; typecheck clean.

Follow-up (2026-09-24): the original successful-plan test missed an invalid
paid reply. `plugins/goal/test/lifecycle.test.ts::an invalid paid planner reply still exhausts the goal budget`
failed before the accounting move with `Expected: 42, Received: 0`, then passed.
The response is checkpointed before validation so a failure below budget also
survives recovery; a provider error without a response has no reported usage.
