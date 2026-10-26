# Agent Note: Scope the post-candidate tool block to the claiming run

Status: implemented

## Problem

`pi-goal` blocks every tool call once a completion candidate is awaiting
verification. The block exists so the run that made the claim ends, and the
verifier can judge a settled transcript.

But `agent_start` treats every turn under an active goal as a goal work run, and
the block was keyed only on "a candidate is pending". A background result —
workflow, subagent or bg-bash — delivered at the settled boundary starts exactly
such a turn. If the candidate was already ready, that new turn inherited the
block:

- every tool call in it was blocked with `terminate: true`;
- after two further turns `pi-goal` paused the goal with "Completion candidate
  could not settle after two further turns";
- the delivered result was visible to the model but unusable.

The verifier never got the evidence the result carried, because the turn could
not act on it.

## Decision

Give `WorkRun` a `candidateGuard` flag and key the block on it.

- At `agent_start`, `candidateAwaiting` is computed **before** the status
  transitions (`ready` or `verifying`). A turn that starts with a claim already
  pending gets `candidateGuard: false`; it did not make the claim.
- `update_goal({ kind: "candidate_complete" })` sets `work.candidateGuard = true`
  for the run that reports it. The claiming run is still forced to end, whether
  it started as a continuation, a user turn, or a background-result turn.
- `candidateAwaitsSettlement()` returns false when the guard is off, so
  `turn_start`'s cap and `tool_call`'s block no longer apply to the delivered
  result's turn. Verification still runs at its settlement; the candidate stays
  `ready`, and the verifier sees the updated transcript.

## Alternatives considered

**Queue the background result until verification finishes.** Correct in the
abstract, but it needs a cross-plugin turn gate (goal would have to tell each
delivery queue when to release) and it makes a result that could inform the
verification arrive after it. The claim is not withdrawn by acting on new
evidence; a better candidate is a new generation.

**Skip verification when a background turn starts.** It loses the candidate
instead of judging it, and the next run would have to re-report the work.

**Inspect the transcript at `agent_start` to detect the background message.**
The event does not carry the triggering message, and custom messages are not
necessarily the last branch entry. A structural flag is testable; transcript
sniffing is not.

## Consequences

The reporting run keeps the hard stop that makes verification possible. A turn
started while a claim is pending — background result, user follow-up, or another
extension's follow-up — may use tools, and the goal is not paused merely because
a result arrived. `workRuns` still counts that turn, so the run cap remains the
outer bound.

No snapshot format change: `candidateGuard` is in-memory, per run.

## Verification

- `plugins/goal/test/lifecycle.test.ts::goal and subagent deliver a late child at settlement before verifying its candidate`

The test now asserts both halves: the claiming run's `tool_call` returns
`{ block: true, terminate: true }`, and the tool call in the post-delivery turn
is `undefined`.

Proved: changing the guard check to `if (false && !work.candidateGuard)` made
that test fail with the block object received where `undefined` was expected
(`0 pass, 101 filtered out, 1 fail`). Restored, the file is `102 pass, 0 fail`.

`plugins/goal/test/background-combination.test.ts` — all four goal/workflow/
subagent/bg-bash orderings pass, including the navigation case that drops the
queue.
