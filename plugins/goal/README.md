# pi-goal

Requires pi **0.85.1 or newer** (uses `agent_settled` and the model registry's
isolated completion API). From this workspace, install locally with:

```sh
pi install -l ./plugins/goal
```

`pi-goal` keeps one user-controlled objective with the session. Start it with
`/goal <objective> [--tokens N]`; inspect it with `/goal status`; use
`/goal pause`, `/goal resume`, `/goal clear`, or `/goal replace <objective>`.
After a goal completes or reaches its token budget, `/goal <objective>` starts
a fresh goal directly. An active or resumable goal still requires `replace` or
`clear` before starting a different objective.

The agent can call `get_goal` and `update_goal` to report material progress, a
candidate completion, or a blocker. It cannot resume a paused goal or declare
completion. An unfinished work run continues without a verifier call. After a
run reports `candidate_complete` and settles, the plugin asks the current
configured model in an isolated, tool-free completion to verify transcript
evidence. Invalid JSON, provider errors, redactor errors, cancellation, and
timeouts pause safely rather than pretending success. Completion is only
reported after a valid verifier verdict.

Each completion claim has a monotonic generation and one phase: `reported`
while its work run is open, `ready` after a clean final response or when
`pi-goal` terminates a post-candidate tool batch, `verifying` while the isolated
judge runs, or `interrupted` when a fresh report is needed.
Verification is deferred to the next event-loop turn after Pi emits
`agent_settled`, giving other synchronous extension handlers a chance to
deliver follow-ups before the idle check. A verdict is applied
only to the generation and run epoch it started with, with no queued messages;
follow-ups arriving during verification defer judgment to the later transcript.
Older goal snapshots are migrated when restored, and any claim left in flight
is treated as interrupted.

If a background completion queues a follow-up as the reporting run ends, the
cleanly reported candidate remains ready for verification. The follow-up may
arrive before the verifier can run; its next clean settlement verifies the
existing candidate without asking the agent to re-report or repeat the tests.
After reporting a candidate, further tool calls in that run are blocked with
termination requested. When Pi ends on that goal-blocked tool batch (`toolUse`),
the candidate stays ready and is verified after settlement; no final text
response is expected from that run. Pi only stops a tool batch early when every
call in it terminates, so `pi-goal` also pauses and aborts after two more turns
if the run still has not settled. An errored or aborted run still requires a fresh
report after resume.
If another extension starts a turn while verification is in flight, the older
verdict is discarded and the pending candidate is judged after that turn, with
the newly delivered result in the transcript.

A goal that reaches a terminal status — `complete` or `budget_limited`, exactly
the two `/goal resume` refuses — is **retired**: it stops being injected into the
model context and drops out of the status bar. The snapshot is kept, so
`/goal status` and session restore still report it. This is deliberate: leaving a
finished goal in context makes the model narrate its completion on the user's
next unrelated request instead of just answering it. `paused`, `blocked` and
`no_progress` keep injecting, because their "do not resume automatically" line is
a decision the model must still respect after a compaction.

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

Each goal's plan lives at `<session dir>/goal-plan-<goal id>.md` and holds exactly two sections:

```markdown
## Acceptance criteria
1. <outcome, not architecture>

## Task checklist
- [x] <step the implementer finished>
- [ ] <step the implementer has not>
```

The plugin keeps these files after `/goal clear`, `/goal replace`, and terminal
completion. An older session branch or a fork can still reference a previous
goal's plan, so there is no per-session file-count or age limit. Remove plan
files only when the session history and any forks that reference them are no
longer needed.

`## Acceptance criteria` is the gating bar: short, outcome-shaped, anchored to
the literal objective, never naming a file or a function. `## Task checklist` is
the implementer's own progress record. The plugin reads the **first unchecked
box** before each work run and presents it as a starting point. The agent may
advance through several steps in one run. During that run, context injection
does not repeat the starting point, since the file may already have changed.
The queued continuation is only a trigger; the first context call after the
run starts supplies the freshly read step.

**The criteria section is not a contract the implementer can edit.** The plugin
keeps the criteria it was first given and hands those to the verifier on every
round; the file's copy is a rendering for the reader. An implementer that
rewrites its own criteria to something easier cannot narrow the bar it is
judged against — the verifier is merely told the section was edited, so it can
weigh that against the evidence it finds itself.

## Continuation bounds

Three guards stop a goal from driving itself forever. A verifier that can always
name *some* next action otherwise never terminates a goal that has no token
budget set.

- **Run cap** — after `PI_GOAL_MAX_RUNS` work runs (default 12) in one attempt,
  the goal pauses, including when none reported completion or plugin follow-ups
  prevent `agent_settled`. The cap is checked before another run starts and
  *before* a verifier round, so the last round is never paid for and discarded.
- **Candidate turn cap** — after a candidate is reported, at most two further
  turns may start in one run before the goal pauses. It aborts only a turn
  started by the goal; a user-owned turn is left running.
- **Stall detection** — a verifier `nextAction` is folded to a fingerprint
  (lowercased, punctuation and whitespace collapsed, and high-entropy tokens
  such as a scratch path, uuid or generated id normalised away). Repeating the
  same fingerprint `PI_GOAL_STALL_RUNS` times (default 2) pauses the goal as
  `no_progress`: the verifier is re-litigating, not converging. The fold is
  deliberately not lossy where it matters — plain integers and line numbers are
  kept, so `Run test 3` and `Run test 4`, or `src/a.ts:41` and `src/a.ts:42`,
  still count as different work.

`/goal resume` restarts the attempt. It clears the run counter and the stall
streak while keeping the lifetime totals, so a resume is the user authorizing
another attempt rather than an unbounded extension.

Snapshots are appended to the session as `goal-state` at run and verification
boundaries, not once per assistant message — a long goal previously grew the
session file without bound. The budget is checked when each assistant message,
delegated call, planner call or verifier call reports usage. Loading a session or
navigating its tree restores the branch
snapshot but pauses it until `/goal resume`. Counters added after the first
schema-1 snapshots are backfilled, so a session written by an older build
restores instead of being discarded.

Continuations yield to queued user messages. Pause, clear, replace, user input,
session switching, tree navigation, and shutdown invalidate stale
continuation/verifier callbacks — including the planner, which is a model call
like the verifier and would otherwise finish after the goal it belonged to was
replaced. Token accounting deduplicates assistant message usage across events
(the same object is counted once even if a field changed between the two events)
and includes planner and verifier usage. Foreground subagents and background
workflows launched during a goal work run report cache-inclusive usage through
the same goal-owned service. A budget moves the goal to `budget_limited` as soon
as reported spend reaches it: a run the plugin started is stopped there, a user
turn is left to finish, and new delegations are refused. This is a soft budget:
an in-flight model response or child process can overshoot before its usage is
reported. A background result from a replaced goal or a different session is
not charged to the current goal. Start a replacement goal to authorize more
budget.

A snapshot that cannot be written logs a warning and keeps the in-memory goal
authoritative; the next boundary retries the write. A goal that is not workable
is never silently dropped: a status word from a newer build restores as
`paused`, with the reason, rather than taking the objective and its counters with
it.

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
summaries), not the filesystem or external services directly. The transcript keeps
whole entries from the start and end of a long goal, eliding the middle when
necessary, and is capped between 2,000 and 64,000
characters by the model's context window. Its evidence is asked to separate
executed tests visible in tool results (command and outcome) from conclusions
inferred by the model; this classification is itself a model judgment, not a
machine-verified test ledger or a guarantee of correctness. A read-only child
could inspect the workspace directly in a future opt-in mode, but would incur
another agent run and still need explicit tool limits, accounting, cancellation
and evidence provenance. No such mode is enabled without real-task evidence of
what the transcript-only verifier misses. Each verification incurs an additional
model request and has a 45-second deadline. Cancellation releases the plugin
immediately, but an uncooperative provider may still bill its request; late
results are discarded. No background daemon or live extension installation is
performed by the development tests.

## Configuration

A goal is a property of the session a *user* is in. A child process spawned to do
one delegated job has no user, no goal of its own, and no business resuming the
parent's — so a spawner sets `PI_GOAL_DISABLE=1` in the child's environment and
the plugin registers nothing there. pi core has no subagent primitive, which
makes that the spawner's job; `pi-workflow` does it for its children.

| Variable | Default | Meaning |
|---|---|---|
| `PI_GOAL_MAX_RUNS` | `12` | Work runs per attempt before the goal pauses for `/goal resume`. |
| `PI_GOAL_STALL_RUNS` | `2` | Repeated identical verifier `nextAction` fingerprints before the goal pauses as `no_progress`. |
| `PI_GOAL_PLAN` | `true` | Write a plan at goal creation before the first work run. |
| `PI_GOAL_VERIFIER_MODEL` | *(unset)* | Model that judges completion, as `provider/modelId`. Unset uses the session's active model. |
| `PI_GOAL_DISABLE` | *(unset)* | Set to `1` in a child process's environment so it registers no goal surface at all. |

All five are read per call, so `/reload` picks up a change without restarting
pi.

### Running the verifier on its own model

An unset `PI_GOAL_VERIFIER_MODEL` verifies with the session's active model, which
is the default and changes nothing. Setting it makes verification a
cross-model judgment:

```sh
PI_GOAL_VERIFIER_MODEL=anthropic/claude-sonnet-4-5 pi
```

A model that shares the implementer's blind spots is the weakest possible judge —
the mistake it just made is the one it will fail to see. A different model breaks
that correlation, and because the verifier and the implementer are billed
separately this also lets an expensive model do the work while a cheaper one
verifies, or the reverse.

A malformed spec is ignored rather than guessed, and a spec that names an unknown
model or one without configured authentication falls back to the active model
with a one-time warning. Verification therefore never becomes impossible because
of a typo. The model that judged is recorded on the goal snapshot as
`verifierModel`, so a verdict stays attributable after the fact.
