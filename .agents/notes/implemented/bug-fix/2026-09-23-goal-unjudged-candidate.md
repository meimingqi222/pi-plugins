# Agent Note: An unjudged candidate must not read as a rejected one

Status: implemented

## Problem

`update_goal(candidate_complete)` sets `goal.candidate`, but the verifier only
runs when the work run settles cleanly (`agent_settled` with a non-error,
non-abort stop reason). A run that errored or was aborted *after* the candidate
was reported paused the goal with a bare "Agent error." — and `/goal resume`
then cleared `goal.reason` entirely. The next continuation prompt carried a
`candidate` field with no indication whether the verifier had judged it.

Observed in a real session: network errors ended every run after the candidate
was reported, the verifier never ran once, and the agent — unable to tell
"never judged" from "rejected" — re-ran the full verification effort and
re-submitted the same candidate on every resume.

## Decision

- `goal.candidatePending` (optional boolean, schema 1 compatible): set when a
  `candidate_complete` is recorded, cleared the moment a verdict is parsed.
  `candidate` + `candidatePending` means "reported but unjudged"; `candidate`
  alone after a rejection means "the verifier's required next action".
- `goalPrompt` spells the distinction out: an unjudged candidate gets
  "has NOT been judged … re-report", a rejection gets the verdict reason,
  evidence and the required next action, and a pending candidate alongside an
  old verdict is marked as postdating it.
- `goal.reason` survives `/goal resume` and is surfaced as "last paused with",
  so the agent sees *why* the previous attempt stopped instead of a bare
  active state.
- Error/abort pauses name the unjudged candidate: "Agent error; a reported
  candidate was never verified."
- `update_goal` tells the caller at record time that the candidate is verified
  only when the run settles, and must be re-reported if the run is interrupted.

## Alternatives considered

**Verify errored runs anyway.** The transcript exists, but an errored run is a
provider failure the user should see; auto-verifying would burn a round on a
run whose evidence is known-incomplete and hide the failure.

**Clear `candidate` when a run ends unverified.** Loses the claim the agent
made; the flag keeps it and marks it pending instead.

## Consequences

`goal.candidatePending` is optional, so schema-1 snapshots restore without
migration; a candidate recorded before this field existed reads as already
judged, which is the previous behaviour. A parsed verdict clears the flag, so it
never accumulates, and a candidate recorded after an older rejection is marked
as postdating that verdict rather than being confused with it.

`goal.reason` now survives `/goal resume` and is surfaced as "last paused
with", so resuming shows why the previous attempt stopped instead of a bare
active state. Error and abort pauses name an unjudged candidate, which changes
the pause text a user and the agent see.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — the "goal candidate verification
  status" suite: an errored run flags the candidate unjudged and the prompt says
  so; a rejection clears pending and names the verdict and next action; a fresh
  candidate after a rejection is pending again with the old verdict marked as
  predating it; the pause reason survives resume.

Proved: removing `goal.candidatePending = true` when a `candidate_complete` is
recorded failed `plugins/goal/test/lifecycle.test.ts`'s "a candidate in a run
that errors is flagged unjudged, and the prompt says so" with
`Expected: true, Received: undefined`, then passed again after restoring the
line. Full workspace after restoring: 542 pass, 0 fail.
