# Agent Note: Session teardown cancels pending subagent admissions

Status: implemented

## Problem

Session teardown aborted active lanes but left foreground slot waiters alive.
A settling old lane could grant its slot to an old session's queued call.
Capturing the generation after the wait also accepted a reservation granted
just before teardown. Neither case requires the host to provide an abort signal.

## Decision

Cancel and detach all queued slot waiters before aborting active lanes. Capture
the session generation before acquiring a slot and recheck generation and
session identity before launching. Release a granted reservation when its
origin is stale; never reset reservation accounting globally because a caller
still owns the granted slot until it resumes.

## Alternatives considered

- Rely on the host abort signal: embedded hosts may omit it, and session ownership
  belongs to the extension regardless of host behavior.
- Only cancel the queue: an already granted reservation is no longer queued.
- Only suppress old result delivery: that still starts unwanted child work.

## Consequences

Old queued calls return aborted without spawning. Admission remains FIFO and
the next session can claim released slots normally. All existing teardown
events share this cleanup path.

## Verification

- `plugins/subagent/test/lane-reply.test.ts::session teardown cancels queued foreground calls without a host abort signal`
- `plugins/subagent/test/lane-reply.test.ts::session teardown rejects an already granted foreground reservation`

Proved: before the fix, the queued call did not return aborted and the granted
call invoked the executor after teardown. Both failures are saved in
`.agents/notes-evidence/2026-10-07-subagent-lifecycle-red.txt`. After the fix,
both tests pass; the focused two-file suite has 42 pass, 1 skip, and 0 fail.
