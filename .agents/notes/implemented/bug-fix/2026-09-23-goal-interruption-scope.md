# Agent Note: Scope goal interruption to goal-driven runs

Status: implemented

## Problem

The plugin treated every agent run under an active goal as goal work, so it could
not tell its own continuation apart from a turn the user asked for. Two defects
followed from that one missing distinction.

**A user turn was killed by `/goal pause` and `/goal clear`.** `agent_start` set
`work` whenever a goal was active, and both commands did `const abortWork = !!work;
... if (abortWork) ctx.abort()`. The intent was to stop an in-flight continuation,
but the condition also matched an ordinary turn: with an active goal, asking an
unrelated question and then pausing interrupted the answer to that question. The
user asked for that output; the goal mechanism stopped it.

**A continuation queued before a stop still ran.** `schedule()` hands the
continuation to Pi with `deliverAs: "followUp"` and `triggerTurn: true`, and a
follow-up cannot be unsent. If the goal was paused or cleared between queueing and
the turn starting, `agent_start` returned early on `goal?.status !== "active"` —
silently letting the turn run. The next model request was paid for, and worked
toward a goal the user had already stopped.

The mirror case also had no handling: a user follow-up arriving inside a
continuation-started run inherited the run's provenance, so pausing would
interrupt output the user had explicitly asked for.

## Decision

Track continuation provenance per attempt, not per run.

- `WorkRun` gains `continuationDriven`, set from a `continuationOutstanding` flag
  that `schedule()` raises when it hands Pi the continuation message.
- `agent_start` consumes the flag for that attempt only, so a user follow-up
  inside a continuation-started run is correctly reported as user-driven. This is
  the deliberate part: provenance is per attempt, because a run can contain both
  a continuation and a user follow-up.
- `/goal pause` and `/goal clear` interrupt only when `work?.continuationDriven`.
  A user turn is left to finish; it simply stops being accounted as goal progress.
- When `agent_start` sees an inactive (or absent) goal but a consumed continuation
  flag, it aborts the turn and notifies with the same "Run /goal resume" guidance
  the other auto-stop paths use. The message is sent regardless of the resumable
  status, because a queued turn that did not start a goal run is worth reporting
  either way.

`restore` and `leave` reset the flag so a session switch cannot carry a standing
continuation into the next session.

## Alternatives considered

**Abort unconditionally on pause and clear, as before, and accept that user turns
are interrupted.** That is the status quo, and it makes an ordinary question
unanswerable whenever a goal is active — the failure is worse than the cure.

**Track provenance on the goal snapshot instead of the run.** Provenance is a
property of one in-flight attempt, not of the persisted goal. Storing it on the
snapshot would have to be cleared at every boundary and would survive a reload
that should have dropped it.

**Match on the continuation message's `customType` in `agent_start`.** The event
does not carry the triggering message, so the plugin cannot see it there; the
flag set at `sendMessage` time is the only reliable signal.

**Drop the queued continuation instead of aborting the turn.** Pi cannot unsend a
queued message, so the plugin cannot prevent the turn from starting. Aborting it
at `agent_start` is the earliest point it can act, and it keeps the goal state
authoritative.

## Consequences

A user turn under an active goal survives `/goal pause` and `/goal clear`, which
is the observable fix. A continuation queued before a stop is aborted at
`agent_start` with a notification instead of running to completion, so a stopped
goal no longer pays for one more model request.

`work.continuationDriven` is internal to the plugin; the persisted `Goal` shape is
unchanged, so existing snapshots restore without migration.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::pausing during a user turn does not interrupt the user's own output`
- `plugins/goal/test/lifecycle.test.ts::clear also leaves a user turn running`
- `plugins/goal/test/lifecycle.test.ts::a user follow-up inside a continuation run is not goal-driven`
- `plugins/goal/test/lifecycle.test.ts::pausing during a continuation turn interrupts the goal-driven run`
- `plugins/goal/test/lifecycle.test.ts::a continuation queued before pause is stopped when it starts`

Proved: reverting each guard independently fails a distinct test.

Removing the `work?.continuationDriven` scoping in the pause and clear handlers
fails exactly the three user-turn tests (`48 pass, 3 fail`); the two
continuation-side tests still pass, so the scoping is what protects the user turn.

Making `agent_start` return early on an inactive goal, with no abort for a
consumed continuation flag, fails only
`a continuation queued before pause is stopped when it starts` (`50 pass, 1 fail`).
The probe was confirmed by `grep -c "Stopped a queued goal turn"`, which returned
`0` after the edit and `1` before it. Each guard therefore pins a distinct
behaviour rather than both resting on one assertion.

Full suite after restoring both: `75 pass, 0 fail`, `bun run typecheck` clean.
