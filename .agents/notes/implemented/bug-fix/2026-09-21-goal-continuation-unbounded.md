# Agent Note: Bound goal continuation instead of relying on a budget

Status: implemented
Partly-superseded-by: 2026-09-24-goal-work-run-efficiency.md

## Problem

Nothing terminated a goal whose verifier kept finding work. The only exits were
a token budget, a three-run blocker streak, and a passing verdict. A goal
started without `--tokens` therefore drove itself indefinitely: each settled run
paid for a verifier round, the verifier named *some* next action, and the cycle
repeated. `goal.workRuns` was counted for the status line but never consulted by
any decision, so the number was diagnostic only.

## Decision

Two independent guards, both per attempt and both cleared by `/goal resume`:

- **Run cap.** `agent_settled` compares `attemptRuns` against
  `PI_GOAL_MAX_RUNS` (default 12) and pauses before starting another verifier
  round. Checking it ahead of the verification means the final round is never
  paid for and discarded.
- **Stall detection.** A verifier `nextAction` is folded through
  `nextActionKey` — lowercased, with punctuation and whitespace collapsed — so
  two rounds asking for the same work in different words produce the same
  fingerprint. `PI_GOAL_STALL_RUNS` (default 2) repeats of one fingerprint move
  the goal to the new `no_progress` status. A reworded action naming different
  work resets the streak.

`attemptRuns` counts runs since the last resume and is separate from the
lifetime `workRuns`, which stays the blocker-streak index. `/goal resume`
resets the attempt counters and the stored fingerprint while keeping the
totals, so a resume is the user authorizing another attempt rather than an
unbounded extension.

Both limits are read per call rather than captured at load, so `/reload` picks
up a change. `attemptRuns` and `stalledRuns` are optional in the schema and
backfilled by `restoreGoal`, so a session written before this change restores
instead of being discarded as a bad snapshot.

## Superseded

The run cap and stall guard still apply, but an unfinished clean run now continues without a verifier call. The earlier every-run verification behavior is superseded by `2026-09-24-goal-work-run-efficiency.md`.

## Alternatives considered

**Cap on `workRuns` instead of a separate counter.** Resuming would then have to
either reset the lifetime total — losing the number the blocker streak indexes
by — or leave the cap permanently consumed after the first pause.

**Detect stalls on the whole verdict rather than `nextAction`.** The reason text
varies freely between rounds for the same request, so a verdict fingerprint
would fire on rewording and stall a goal that was actually converging.

**Fail the goal instead of pausing.** Both guards are recoverable states: a
stalled goal usually needs a human decision about scope, not termination, and a
paused goal keeps its evidence and elapsed accounting.

**Rely on the token budget.** A budget is optional, and `--tokens` is exactly
the case a user skips when they want the goal to run to completion.

## Consequences

A goal now stops on its own in two situations a user previously had to notice
and interrupt. Both land in a resumable state with the reason in `/goal status`,
and `no_progress` is distinct from `paused` so a stall is not mistaken for a
user stop or a cap pause. The defaults are deliberately conservative: 12 runs
and 2 repeats. A legitimate goal that needs more is resumed, not lost.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::work run cap pauses before paying for another verification`
- `plugins/goal/test/lifecycle.test.ts::repeated next action pauses as no_progress and resume restarts the attempt`
- `plugins/goal/test/lifecycle.test.ts::a reworded next action counts as progress`
- `plugins/goal/test/lifecycle.test.ts::snapshots written before the run cap still restore`

Proved: removed the `attemptRuns >= maxRuns` guard and the stall block in turn.
The run-cap test failed with status `active` and a second verifier call billed;
the stall test failed with status `active` after two identical next actions.
Restoring both guards returned the suite to green.
