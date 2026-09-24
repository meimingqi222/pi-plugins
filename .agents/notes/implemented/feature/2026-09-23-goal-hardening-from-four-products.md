# Agent Note: Take six hardening ideas from the four products pi-goal was compared against

Status: implemented

## Problem

A workflow compared the goal subsystems of Step-Code, ZCode, grok-build and
opencode against this plugin, and an adversarial verifier checked the
recommendations it produced. Seven ideas survived the check; six were applicable
here. Two recommendations were refuted and are recorded below so they are not
re-proposed.

The gaps, each with the product that does it better:

- **An unknown status word deletes the goal.** `isGoal` rejected any status it did
  not know, and `restoreLatestRun` treats an invalid newest snapshot as absent —
  so one word written by a newer build discarded the objective, its budget and
  every counter.
- **A weakened criterion arrives as a boolean.** `criteriaEdited: true` told the
  verifier that the plan's criteria section changed, not *what* it no longer said.
- **Model-authored text was inlined into an authoritative prompt.** `goalPrompt`
  interpolates `progress`, `candidate`, `blockerReason`, the plan's first
  unchecked box (which the implementer is invited to edit) and the verifier's own
  `reason`/`evidence`.
- **The plan path was written through whatever was there.** `writeFile` follows a
  symlink, and the plan path is predictable and inside the session directory.
- **A child process could inherit the parent's goal.** pi core has no subagent
  primitive, and ambient extensions load in a child.
- **Two hand-written status lists had to stay exact complements.** `isRetired`
  and the resume command's accepted set, plus a third variant at one call site.

## Decision

**An unknown status restores as `paused`, with the reason on the snapshot.**
`isGoal` validates the *shape* of the status; `coerceStatus` maps the words this
build knows and everything else to `paused`, and `restoreGoal` records why.
Grok's tracker makes the same trade (unknown wire status → `UserPaused`), and
pausing is the fail-closed direction: the goal stops and the user is told, rather
than continuing under a meaning nobody has defined. Deleting it is the one
outcome the user cannot recover from.

**The verifier is told which criteria were dropped.** `compareCriteria` returns
`{removed, added}` as trimmed, case-folded set differences — so a reorder is not a
change and a reword is one removal plus one addition — bounded by the plan's own
caps because an implementer-controlled file must not be able to size the prompt.
`criteriaEdited` stays: it catches the reorder that produces no set difference.

**Model-authored text is fenced, not censored.** `fenceModelText` strips tag
shapes and control characters and caps length; the text is still shown, it just
cannot close the envelope it is shown in. Applied to every field in `goalPrompt`
the model can write, and to the objective, which is user-authored but still
inlined. Grok does the same (`neutralize_reminder_tags`,
`neutralize_directive_slot`).

**The plan path is `lstat`ed before it is written.** A symlink, directory, fifo or
device is refused with a warning and the goal runs without a plan, exactly as it
does when planning fails. Absent is the normal case. Grok's `PlanGuard` refuses
in the same place, which is also why its strategist's edits are reverted byte for
byte.

**A child is told it is not the user's session.** `PI_GOAL_DISABLE=1` makes the
plugin register nothing, and the shared runner (`pi-agent-runner`) sets it in
every child's environment via `agentChildEnv()`. pi core has no subagent
primitive, so this is the spawner's contract — the same shape Step-Code uses
(`STEP_DISABLE_GOAL` for its own subagents). Relying on a child having no
session would be relying on an accident of how it was launched.

**One classification, both answers derived.** `goalDisposition` returns
`running | resumable | terminal`; `isRetired` and `isResumable` read it. The call
site that used its own pair turned out to be equivalent — only `paused` and "no
goal" are reachable where it runs, since every other ending skips the
continuation that would have queued that turn — which is precisely why the
duplication was worth removing: it was correct by luck, and nothing kept it
correct.

**The oversized-newest clip branch gets a test that reaches it.** The existing
test put the oversized entry first, so the reverse walk filled the budget from the
newest end and never hit the branch. The case is now split: an oversized *oldest*
entry is elided, an oversized *newest* entry is clipped to exactly the budget.

### Refuted, and therefore not adopted

- **A tool-free re-plan on a repeated stall (grok-build).** grok's strategist is
  not that: it is a tool-equipped subagent fired on a *streak* of NotAchieved
  verdicts, and its effect is to raise the cap (`GOAL_STRATEGIST_CAP_BONUS`), not
  to pause when a re-plan repeats. The mechanism contradicts this plugin's
  tool-free-judge design, so nothing was taken from it.
- **Checking the budget from a goal tool's `execute` (ZCode).** ZCode registers no
  goal tool at all — its `session-target.ts:271` is a SQL usage-accounting UPDATE
  reached at run end. The transferable half was already covered by enforcing the
  budget in `account()` instead (see the await-windows note).

## Consequences

A goal survives a downgrade instead of vanishing. A judge can weigh the removal of
a criterion rather than infer intent from a flag. A report containing
`</goal-context>` no longer terminates the plugin's own block. A squatted plan path
cannot redirect the gating contract out of the session directory. A workflow child
registers no goal surface, so the parent's objective cannot leak into it and the
parent's budget cannot pay for it. `isRetired`/`isResumable` cannot drift apart.

## Alternatives considered

**Treat an unknown status as invalid, as before.** One line simpler, and it makes
the failure a silent deletion of the user's objective — the worst possible
outcome for the least visible cause.

**Have `/goal` fix up the status when the user resumes instead of coercing on
restore.** The goal is invisible to the model and absent from the status bar while
it waits for that command, so the user has to guess that a run is sitting there.

**Drop `criteriaEdited` and send only the diff.** A reorder is an edit that
produces no set difference, and the boolean is the only signal that catches it.

**Reject a plan file whose criteria do not parse, instead of ignoring the file.**
That turns an implementer's typo into an unverifiable goal; ignoring it keeps the
outcome about the work rather than about the file.

**Censor the fenced text instead of neutralizing it.** The verifier needs to see
what was claimed, and a silently rewritten report is worse evidence than a
visibly quoted one.

**Make child isolation the child's own problem.** There is no way for a child to
know it is one: it has no marker, and a fresh session looks exactly like a session
whose user has not set a goal yet.

## Verification

- `plugins/goal/test/state.test.ts` — "retirement and resumability cannot drift
  apart"; "an unknown status from a newer build pauses instead of deleting the
  goal"; "a closing reminder tag cannot escape the block it is shown in";
  "control characters are flattened and length is capped"; "goalPrompt fences
  every field the model can write".
- `plugins/goal/test/lifecycle.test.ts` — "a status from a newer build pauses the
  goal instead of deleting it" (status, objective, budget, `used` and the reason
  all survive the restore).
- `plugins/goal/test/loader.test.ts` — "the plugin registers nothing in a process
  told to run without goals" (no commands, no tools, no handlers).
- `plugins/workflow/test/child-guard.test.ts` — "a workflow child is told not to
  run the user's goal", including that the parent's environment is inherited
  rather than replaced.
- `plugins/workflow/test/plugin-wiring.test.ts` and `test/progress.test.ts` carry
  the criteria-diff and run-verdict coverage from the same comparison.

Proved: reverting `coerceStatus` in `restoreGoal` to a cast (`goal.status as
GoalStatus`) fails "a status from a newer build pauses the goal instead of
deleting it" with `Expected: "paused" / Received: "frozen"`. Removing the
`fenceModelText` call on the objective fails "goalPrompt fences every field the
model can write" on `<system-reminder>`. Disabling the `planPathIsSafe` guard
fails "a plan path squatted by a symlink is refused" with the outside file
rewritten.

Full workspace: 730 pass, 0 fail (goal suite 82 → 98, workflow 269 → 278);
typecheck clean on every package; the regression-notes verifier accepts this tree.
