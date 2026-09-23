# Agent Note: Make a running workflow observable, and a wait-poll a clean stop

Status: implemented
Partly-superseded-by: 2026-09-23-workflow-status-hides-failed-agents.md

## Problem

Two defects had the same root: the plugin had no way to say "I am still working",
so the model improvised.

**A running workflow was opaque.** `runWorkflow` builds a full `WorkflowProgress`
snapshot — phase, every agent with its status and start time, completed count,
tokens, last update — and calls `onProgress` on every phase, log line, agent
start, and agent finish. Nothing consumed it. `execute` returned at once, so the
tool's `onUpdate` had no reader, and the only progress surface was `/workflows`,
which notifies the *user*. A model that had launched a run could not say whether
it was on phase 1 or 5, whether two agents were in flight or none, or whether the
last event was 4 seconds or 11 minutes ago.

**The wait was a poll.** With no way to observe, and no guarantee of being woken,
the model did what a model does: `bash: sleep 30`, then again. That is not merely
wasteful — it is the exact failure the auto-background plugin exists to prevent,
reintroduced on the provider side. Worse, it poisoned the signal: a long `sleep`
loop looks identical to a hung run from the outside.

The two are one bug. Observability is what makes waiting unnecessary; a
deterministic stop is what makes waiting safe.

## Decision

Consume the progress that already existed, expose it to the model, and turn the
poll into the stop it was trying to be.

- **`RunRegistry` stores progress.** `RunRecord` gains `progress` and the
  requested `agentTimeoutMs`; `setProgress(runId, snapshot)` replaces it. A
  settled run ignores later updates, so a straggling progress event cannot
  resurrect it or contradict its result.
- **A `workflow_status` tool.** It reports, per active run: elapsed, phase,
  agents seen/running/completed, each running agent's age, tokens, age of the
  last progress event, and whether a per-agent timeout bounds it. It is a
  separate tool rather than a `workflow` action, because the launch tool's
  "exactly one of `script`/`scriptPath`/`name`" rule is load-bearing and an
  action union would muddy it.
- **The status reports a bound, not a verdict.** A single agent call emits no
  progress between start and finish, so "no event for 8 minutes" is normal for a
  healthy run. The honest evidence is each running agent's age plus whether a
  cap exists, so the renderer states both and leaves the judgement to the reader.
- **A poll guard.** A `tool_call` handler blocks a bare `sleep` while a run is
  active, with `terminate: true`. The poll itself is the signal: a command whose
  only effect is sleeping proves the model has nothing else to do, which is
  exactly when ending the turn is correct. `sleep 5 && npm test` is not a poll
  and is untouched.
- **A guideline** tells the model not to poll and to use `workflow_status`
  instead. The guard is the guarantee; the guideline is only the hint.
- **The same guard in `pi-bg-bash`.** A background bash job has the same wake-up
  contract, so the same rule applies: a bare `sleep` while a job is running is
  blocked and the batch terminates. The rule is a small pure function, duplicated
  rather than shared because the two plugins install independently and neither
  may depend on the other; each copy points at the other.

`terminate: true` ends the batch, not the run: the workflow keeps executing and
still delivers its result. It is deliberately not returned from the `workflow`
tool itself — a tool cannot know whether the model has other work, and stopping a
turn that has real work left in it would be the opposite mistake.

## Superseded

What still holds: the `RunRegistry` progress storage, the poll guard (and the
same guard in `pi-bg-bash`), the guideline that a bare `sleep` while a run is
active is a poll, and the rule that the status reports a bound rather than a
verdict. The status still reports the phase, each running agent's age, the token
count, the age of the last progress event, and whether a per-agent timeout
bounds the run.

What no longer holds is the field enumeration "agents seen/running/completed" in
`## Decision`. It was incomplete in a way that mattered: a failed agent was
counted in `seen` and nowhere else, so the remainder read as "not started yet"
and a run that had lost half its agents looked healthy. The status now also
counts `failed` and `aborted`, names each stopped agent with its reason, and
carries that reason on `WorkflowProgressAgent`. See
`2026-09-23-workflow-status-hides-failed-agents.md`.

## Alternatives considered

**Return `terminate: true` from the `workflow` tool.** The obvious fix and the
wrong one: it stops every turn that launches a workflow, including the ones with
independent work to do, because the tool has no way to tell them apart. The
guard fires only on a demonstrated poll, so it is conditioned on the thing that
actually means "nothing else to do".

**Make `workflow` blocking.** Claude Code's subagent shape: `execute` awaits the
settle, so the model is never invoked while it waits and cannot poll. It removes
the problem entirely but conflicts with the plugin's reason to exist — a run can
take many minutes, and blocking forfeits the ability to do anything else. Kept
as a possible explicit `wait: true`, not as the default.

**A separate `workflow_wait` tool the model calls to block.** Clean semantics,
but a model that does not think to call it will still poll, and the tool that
reports progress is the one it needs anyway.

**Persist progress to disk.** The registry is in-memory and a run does not
survive `/reload` or a killed pi, so an on-disk progress file would outlive
nothing it is needed for. The journal remains the durable record.

**Have `workflow_status` declare "stalled" past a threshold.** A heuristic with a
false-positive mode and no way to tell a slow agent from a dead one. Reporting
the ages and the bound is more useful and cannot lie.

## Consequences

A model can now tell a slow run from a dead one by reading each running agent's
age and whether a per-agent timeout was set, and can stop a run it judges stuck
without asking the user. The wait-poll disappears, so a `sleep` in the transcript
no longer means "workflow is running".

The guard is deliberately narrow. A legitimate bare `sleep` while a run is
active — waiting on an unrelated server, say — is blocked, and the model's way
out is a command with a purpose. That is the intended trade: a false positive
costs one blocked call, a false negative costs the loop the change exists to
remove.

`workflow_status` is active whenever the plugin is, so the tool list grows by
one. Progress is in-memory only; a run that does not settle before the session
ends is gone, and its journal on disk is the recovery story as before.

## Verification

- `plugins/workflow/test/poll-guard.test.ts` — the pure `isPureWaitCommand` grammar and the block reason
- `plugins/bg-bash/test/poll-guard.test.ts` — the same grammar in the second plugin
- `plugins/bg-bash/test/plugin.test.ts` — the guard blocks and terminates while a job runs, leaves a purposeful sleep, and does nothing when idle
- `plugins/workflow/test/live-status.test.ts` — elapsed scaling, running-agent ages, the timeout bound, settled and empty views
- `plugins/workflow/test/registry.test.ts` — progress storage, `agentTimeoutMs`, and a settled run ignoring later updates
- `plugins/workflow/test/plugin-wiring.test.ts` — status reflects live progress; the guard blocks and terminates; a purposeful sleep and an idle registry are untouched

`175 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: three red runs, each on its own half of the change:

- **`terminate` removed from the guard's blocked result.** It failed exactly
  `poll guard > a bare sleep while a run is active is blocked and ends the turn`
  with `Expected: true, Received: undefined`, so the test pins the termination
  rather than merely the block. Restoring the flag returned it to green.
- **The `onProgress` wiring removed** (`registry.setProgress` never called). It
  failed exactly
  `workflow observability > a status tool reports what an active run is doing`,
  which timed out waiting for the status to report a running agent — with no
  progress stored, the view never moves past "no progress event yet". Restoring
  the wiring returned it to green.
- **`terminate` removed from the `pi-bg-bash` guard.** It failed
  `poll guard > a bare sleep while a job runs is blocked and ends the turn` with
  `Received: undefined` for `terminate`, so the second plugin is pinned by its
  own evidence rather than inheriting the first plugin's.
