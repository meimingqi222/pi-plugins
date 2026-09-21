# pi-goal

Requires pi **0.85.1 or newer** (uses `agent_settled` and the model registry's
isolated completion API). From this workspace, install locally with:

```sh
pi install -l ./plugins/goal
```

`pi-goal` keeps one user-controlled objective with the session. Start it with
`/goal <objective> [--tokens N]`; inspect it with `/goal status`; use
`/goal pause`, `/goal resume`, `/goal clear`, or `/goal replace <objective>`.

The agent can call `get_goal` and `update_goal` to report progress, a candidate
completion, or a blocker. It cannot resume a paused goal or declare completion.
After each settled goal work run, the plugin asks the current configured model in
an isolated, tool-free completion to verify transcript evidence. Invalid JSON,
provider errors, redactor errors, cancellation, and timeouts pause safely rather
than pretending success. Completion is only reported after a valid verifier
verdict.

The optional `pi-redact` service is used for the isolated verifier payload.
Because this completion bypasses provider hooks, a redactor failure refuses the
request. Without `pi-redact`, this independently installable plugin sends the
objective/transcript to the configured verifier model normally.

## The plan

`/goal <objective>` writes a plan before the first work run, so run 1 already has
a contract and a next step. It is one tool-free side call to the configured
model, bounded by the same 45-second deadline as verification, and a failure
costs only the plan — the goal still runs, it just falls back to the verifier's
own next action. Set `PI_GOAL_PLAN=false` to skip it entirely.

The plan lives at `<session dir>/goal-plan.md` and holds exactly two sections:

```markdown
## Acceptance criteria
1. <outcome, not architecture>

## Task checklist
- [x] <step the implementer finished>
- [ ] <step the implementer has not>
```

`## Acceptance criteria` is the gating bar: short, outcome-shaped, anchored to
the literal objective, never naming a file or a function. `## Task checklist` is
the implementer's own progress record. The plugin reads the **first unchecked
box** once per work run and hands it to the model as the next step, so a stale
checklist produces a stale nudge and a current one produces a correct one.

**The criteria section is not a contract the implementer can edit.** The plugin
keeps the criteria it was first given and hands those to the verifier on every
round; the file's copy is a rendering for the reader. An implementer that
rewrites its own criteria to something easier cannot narrow the bar it is
judged against — the verifier is merely told the section was edited, so it can
weigh that against the evidence it finds itself.

## Continuation bounds

Two guards stop a goal from driving itself forever. A verifier that can always
name *some* next action otherwise never terminates a goal that has no token
budget set.

- **Run cap** — after `PI_GOAL_MAX_RUNS` work runs (default 12) in one attempt,
  the goal pauses instead of verifying again. The cap is checked *before* the
  verifier round, so the last round is never paid for and discarded.
- **Stall detection** — a verifier `nextAction` is folded to a fingerprint
  (lowercased, punctuation and whitespace collapsed). Repeating the same
  fingerprint `PI_GOAL_STALL_RUNS` times (default 2) pauses the goal as
  `no_progress`: the verifier is re-litigating, not converging. A reworded
  action that names different work still counts as progress.

`/goal resume` restarts the attempt. It clears the run counter and the stall
streak while keeping the lifetime totals, so a resume is the user authorizing
another attempt rather than an unbounded extension.

Snapshots are appended to the session as `goal-state` at run and verification
boundaries, not once per assistant message — a long goal previously grew the
session file without bound, and the budget is only enforced at a settled
boundary anyway. Loading a session or navigating its tree restores the branch
snapshot but pauses it until `/goal resume`. Counters added after the first
schema-1 snapshots are backfilled, so a session written by an older build
restores instead of being discarded.

Continuations yield to queued user messages. Pause, clear, replace, user input,
session switching, tree navigation, and shutdown invalidate stale
continuation/verifier callbacks. Token accounting deduplicates assistant message
usage across events and includes verification usage; elapsed time covers active
and verifying states, not pauses. A budget moves the goal to `budget_limited`
at the next settled-run or verifier boundary. It is a soft budget: an in-flight
work run can overshoot it. Start a replacement goal to authorize more budget.

## Limits

This is not a daemon and it has no on-disk verifier. It only continues after Pi
settles an agent run. Escape cancels Pi's normal agent run; a verifier running
while Pi is idle has its own abort controller and is cancelled by `/goal pause`,
input, session changes, or shutdown. There is no guaranteed global Escape hook
for that standalone request. A repeated blocker is counted once per distinct
work run, not once per tool call. Three consecutive work runs reporting the same
blocker stop continuation; resume resets this streak. The current run is not
aborted by a blocker report. Setting or resuming starts work immediately;
setting/replacing is rejected while the normal agent is busy.

The verifier reviews a bounded transcript (including tool results and session
summaries), not the filesystem or external services directly. The transcript is
bounded by whole entries taken from the newest end — the oldest are elided
rather than cutting a serialized entry in half — capped between 2,000 and 64,000
characters by the model's context window. A valid verdict is a model judgment,
not a guarantee of correctness. Each verification incurs an additional model
request and has a 45-second deadline. Cancellation releases the plugin
immediately, but an uncooperative provider may still bill its request; late
results are discarded. No background daemon or live extension installation is
performed by the development tests.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_GOAL_MAX_RUNS` | `12` | Work runs per attempt before the goal pauses for `/goal resume`. |
| `PI_GOAL_STALL_RUNS` | `2` | Repeated identical verifier `nextAction` fingerprints before the goal pauses as `no_progress`. |
| `PI_GOAL_PLAN` | `true` | Write a plan at goal creation before the first work run. |

All three are read per call, so `/reload` picks up a change without restarting
pi.
