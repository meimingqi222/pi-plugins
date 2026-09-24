# Agent Note: Avoid bookkeeping loops inside goal work runs

Status: implemented

## Problem

A live SQL agent goal spent most of its first run rereading and editing a three-item plan. It toggled the same completed checklist item off and on several times. The plugin had mined that item at run start and injected it as the authoritative next step on every later context call, even after the agent edited the file. When the unfinished run settled, the plugin also paid for a verifier call despite no completion candidate. The verifier's limited transcript then missed earlier work and supplied an inaccurate next action.

## Decision

The first unchecked plan item is a starting point for a new run, not a command repeated during that run. The continuation carries only a trigger. The first context call after `agent_start` shows the freshly read starting step; later context calls in that run omit the possibly stale `planStep`, tell the agent to continue through the checklist, and discourage status calls made only to acknowledge a checklist item. A clean run without a `candidate_complete` from that same run continues directly. The verifier runs only for a reported completion candidate. Run, budget, error, blocker, and pending-delegation guards still apply.

## Alternatives considered

**Refresh the plan file on every context call.** This adds disk I/O to every model turn and still encourages treating one checklist item as the full run's scope.

**Verify every clean stop.** A clean stop can mean an unfinished milestone. This costs a model call and turns partial evidence into a misleading completion audit.

**Remove the plan entirely.** The held acceptance criteria and a starting hint remain useful; the repeated authoritative instruction was the failure.

## Consequences

Unfinished work continues without verifier spend, and a checklist edit cannot be contradicted by a stale step in the same run. A model that never reports a candidate cannot finish automatically; the existing run cap pauses it for user review. Completion still requires independent verification and its existing evidence limits remain.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::an unfinished work run continues without paying for verification`
- `plugins/goal/test/lifecycle.test.ts::an edited checklist does not receive a stale authoritative step during the same run`
- `plugins/goal/test/lifecycle.test.ts::unfinished runs still stop at the run cap without verifier calls`

Proved: before the fix, the first test observed one verifier call instead of zero, and the second found the old `planStep` and "Next step" instruction after the checklist changed. Both passed after the fix. The cap test passes with two unfinished runs and zero verifier calls.
