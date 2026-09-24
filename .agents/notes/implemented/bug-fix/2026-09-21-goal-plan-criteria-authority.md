# Agent Note: Hold the goal plan's acceptance criteria outside the implementer's reach

Status: implemented
Partly-superseded-by: 2026-09-24-goal-work-run-efficiency.md

## Problem

A goal had no fixed notion of \"done\", so the bar lived entirely inside the
verifier's head and was re-derived from the transcript every round. Two
consequences followed. The verifier had nothing stable to converge on, which is
what made a repeated `nextAction` — and the stall it caused — possible at all.
And there was no artifact the implementer could be held to, so nothing
distinguished \"the objective is met\" from \"the model believes the objective is
met\".

## Decision

`/goal <objective>` now writes `<session dir>/goal-plan.md` before the first work
run, from one tool-free planner side call bounded by the same deadline as
verification. The plan holds exactly two sections: `## Acceptance criteria` (the
gating bar) and `## Task checklist` (the implementer's own progress record). The
first unchecked box is mined once per work run and handed to the model as the
next step.

The section that earns its keep is the checklist, because it replaces an
invented next action with a deterministic one. Everything a larger harness's
planner writes — verification procedure, non-goals, assumed scope,
implementation approach, risks — exists to serve an adversarial verification
panel, and is not produced here.

The criteria are held by the plugin in `goal.planCriteria` and handed to the
verifier on every round. The file's copy is a rendering for the reader. An
implementer that rewrites its own criteria to something easier therefore cannot
narrow the bar; the verifier is told the section was edited so it can weigh that
against the evidence it finds itself. Only the checklist is read as mutable,
because mutating it is its purpose.

Both halves degrade independently and quietly. A planner failure leaves the goal
running without a plan and notifies; a deleted or garbled plan clears
`planStep` instead of nagging a stale one. A replace during the planner call is
rejected by identity, so the old objective's plan cannot land on the new goal.

The stall fingerprint changed with it. It now covers the checklist step *and* the
verifier's action, because either one moving is progress: an implementer working
through the plan must not be stalled by a verifier that words its nudge the same
way twice, and a verifier naming genuinely new work must not be stalled by a
checklist that has not caught up yet. Fingerprinting only one of the two breaks
the other case, so both are covered by a test.

## Superseded

The first unchecked item is now only a starting hint at a run boundary. The older claim that it remains an authoritative next step throughout a run is superseded by `2026-09-24-goal-work-run-efficiency.md`; the held criteria and checklist persistence decisions still apply.

## Alternatives considered

**Let the implementer own the criteria in the file.** The implementer is the
party being judged. Editing its own acceptance criteria is the cheapest way to
pass, and it needs no deception — just a plausible rewording. A diff check that
refuses on weakening would need every legitimate clarification enumerated, which
is a rules engine for a rare case.

**Pause on a criteria edit rather than only reporting it.** A pause on every
honest clarification trains the user to dismiss the pause, and the edit is
already visible to the verifier as a signal alongside the evidence.

**Run the planner as a tool-equipped subagent.** The lite plan is a rewrite of
the objective, not an investigation of the repository. Reading files first would
cost a full agent run to produce two lists that the objective already determines.

**Mine the next step from the verifier alone.** That is what the stall detector
had to paper over: with no shared record of what is left, the verifier invents a
next action every round and eventually repeats itself.

## Consequences

A goal now carries a fixed bar and a deterministic next step, and both survive
`/reload` because they are persisted with the goal. The cost is one model call
at goal creation that the user did not explicitly ask for, bounded by the same
45-second deadline and visible as a working message; `PI_GOAL_PLAN=false`
removes it. The planner output is strict JSON validated for shape, count and
length, so a malformed plan is a planner failure rather than a corrupt file.

The plan is deliberately not a verification procedure. The verifier still sees
only the transcript; the criteria give it a stable bar, not filesystem access.

## Verification

- `plugins/goal/test/plan.test.ts`
- `plugins/goal/test/lifecycle.test.ts`

Proved: four reverts in turn. Reading criteria from the file instead of the
baseline failed `editing the plan's criteria cannot narrow what the verifier
judges` with the weakened criterion reaching the verifier. Dropping the
`goal.id !== goalId` identity check failed `a replace during planning does not
inherit the old plan` with the stale plan applied. Removing the `agent_start`
refresh failed both `checking a box advances the step the next run is given` and
`deleting the plan clears the step instead of nagging a stale one`. Turning the
planner failure into a pause failed `a planner failure leaves the goal running
without a plan`. Restoring each returned the suite to green.

The fingerprint was reverted in both directions: on the verifier's action alone
it failed `an advancing checklist does not count as a stall`, and on the
checklist step alone it failed `a reworded next action counts as progress`.
