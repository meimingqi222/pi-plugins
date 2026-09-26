# Agent Note: Keep a clean goal candidate through a background follow-up

Status: implemented
Partly-superseded-by: 2026-09-26-goal-candidate-generation-state-machine.md

## Problem

In a live SQL agent session, the agent reported `candidate_complete` and then
gave a clean final response. A background shell completion queued a Pi
follow-up at the same boundary. `pi-goal` skipped verification while messages
were pending, but its next prompt treated the candidate as though its run had
failed. The agent repeated the test suite and reported the same candidate
again. It then kept calling shell tools instead of ending the run, so the
verifier never received a settlement.

## Decision

Persist `candidateReady` once the reporting run ends without an error or
abort. A queued follow-up does not erase this readiness: the next clean
settlement verifies the original candidate. The prompt and `update_goal`
reject needless re-reporting. After a candidate is reported, the `tool_call`
hook terminates further tool calls so the run can settle. Errors and aborts
clear readiness and retain the existing fresh-report path after resume.
If a plugin follow-up starts while the isolated verifier is in flight, abort
that stale verdict and verify the same candidate after the follow-up settles.

## Alternatives considered

**Verify inside `update_goal`.** The final response and any queued background
result would be absent from the evidence.

**Ask the model to re-report in the next run.** This is the behavior that caused
repeated tests and paid for a second claim without changing the work.

**Rely only on prompt wording to end the run.** The live model continued to
call shell tools after receiving that instruction.

## Superseded

The candidate lifecycle is now stored as one generation and phase rather than
`candidateReady` plus the earlier flags. The clean-follow-up behavior, tool
blocking, and in-run turn bound remain. The successor also guards queued
messages that arrive during verifier execution.

## Consequences

A clean candidate survives a follow-up and is judged against the later
transcript. A failed background result can still make the verifier reject it.
An interrupted or errored attempt still needs a new candidate report. Tool
calls after a candidate are blocked, so the agent must finish its response
before doing more work. Because Pi only ends a blocked tool batch when every
result terminates, a third post-candidate turn pauses the goal. It aborts the
run only when the goal started that run; a user-owned turn keeps running. This
gives a deterministic goal bound even when another extension keeps the batch
alive; the candidate remains unjudged for an explicit resume.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::a clean candidate survives a background follow-up and verifies without a second report`
- `plugins/goal/test/lifecycle.test.ts::tool calls after candidate completion are terminated so the run can settle`
- `plugins/goal/test/lifecycle.test.ts::an external follow-up during verification defers the verdict until its turn settles`
- `plugins/goal/test/lifecycle.test.ts::candidate loops stop within one run even when tool termination cannot settle it`
- `plugins/goal/test/lifecycle.test.ts::candidate turn cap leaves a user-owned turn running`

Proved: before the fix, the first test received `Re-report candidate_complete`
in the follow-up prompt and the second received no `tool_call` block result.
Both passed after the fix.
The verifier race test first observed `verifying` instead of `active` after the
follow-up began; it then passed with the stale verifier cancelled.
The in-run loop test first failed with `Expected: 1, Received: 0` for aborts
after the third post-candidate `turn_start`, then passed with the turn bound.
The user-owned turn test first observed one abort, then zero after the guard
used `continuationDriven` before calling `ctx.abort()`.
