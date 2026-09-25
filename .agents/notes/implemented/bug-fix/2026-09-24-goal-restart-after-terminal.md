# Agent Note: Start a fresh goal after a terminal goal

Status: implemented

## Problem

A completed goal was retired from context and the status bar but remained as the latest session snapshot. The `/goal <objective>` command rejected every existing goal object, so starting the next task required `/goal replace` or `/goal clear` even after completion. The same contradiction affected budget-limited goals.

## Decision

Use the existing `isRetired` classification at the command boundary. A new objective may replace a terminal `complete` or `budget_limited` snapshot through ordinary `/goal <objective>`. Active and resumable goals still require an explicit replace or clear. The ordinary new-goal path assigns a new id and resets usage, budget, counters and verdict before planning.

## Alternatives considered

**Delete a goal when it completes.** That would remove `/goal status` history and its usage record.

**Require replace for terminal goals.** This preserves the surprising behavior and makes completion harder to move past than an unfinished task.

## Consequences

Users can begin the next goal naturally. The prior terminal snapshot remains in session history, while `/goal status` reflects the new goal. An active or paused goal retains overwrite protection.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::a completed goal can be followed by a new goal without replace`
- `plugins/goal/test/lifecycle.test.ts::a budget limited goal can be followed by a new goal without replace`
- `plugins/goal/test/lifecycle.test.ts::an invalid paid planner reply can be followed by a new goal without replace`
- `plugins/goal/test/lifecycle.test.ts::an active or paused goal still requires an explicit replace`

Proved: before the guard change, the first two tests failed because the prior terminal goal remained current. Both pass after the change; the third pins overwrite protection.

Follow-up (2026-09-25): the new test combines an invalid-shaped paid planner
reply that exhausts the first goal's budget and leaves `planPath` unset with a
plain second `/goal <objective>`. Proved: temporarily restoring the old
`if (goal && verb !== "replace")` guard made the new test fail at the new-ID
assertion; restoring `!isRetired(goal)` made it pass.
