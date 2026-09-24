# Agent Note: Let a reported candidate's run settle

Status: implemented

## Problem

The context prompt treated every pending candidate as if its run had already
ended without verification and told the agent to re-report it. Context is
injected again during the same run. In the local Pi session, the agent reported
completion, read that false instruction, and called `update_goal` seven more
times in one run. The verifier only starts at `agent_settled`, so none of those
calls could produce a verdict; the run was eventually cancelled.

The tool accepted every duplicate and replaced the pending claim. Its reply
said the verifier would run when the run settled, without explicitly telling
the agent to finish its response.

## Decision

Record the `workRuns` index that submitted the pending candidate. During that
run, the injected prompt and tool reply direct the agent to finish with a final
response and stop calling `update_goal`. A duplicate candidate report in that
same run returns a distinct reply and leaves the original claim unchanged.
When a run really ends without verification, the next run still asks for one
fresh report. A parsed verifier verdict clears the run index.

## Alternatives considered

**Verify immediately inside `update_goal`.** Verification needs the settled
transcript, including the final assistant response. Running it inside a tool
call would judge incomplete evidence and alter the established lifecycle.

**Only change the wording.** That removes the false instruction but still lets
repeated calls overwrite the pending claim and receive the same success reply.
The duplicate guard makes the state and feedback unambiguous.

## Consequences

An agent may submit one completion candidate per run. If that run is cancelled
or errors, `/goal resume` starts another run that may re-report the claim.
Older snapshots have no `candidateRun`; they remain readable and take the
conservative earlier-run prompt path.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — "a candidate reported inside the
  running run is not met with a re-report instruction", "a pending candidate
  from an earlier run is still re-reported after resume", and "repeating
  candidate_complete in one run does not replace the pending claim".

Proved: the prompt test failed against the old prompt with the premature
"run ended before verification" instruction. Disabling the duplicate guard
failed the repeated-report test: the second call returned the ordinary
"candidate recorded" reply instead of "already recorded in this run".
