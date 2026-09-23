# Agent Note: Count a failed agent in the workflow status, and carry its reason

Status: implemented

## Problem

`workflow_status` reported only two agent buckets — running and completed — so a
failed agent was counted in `N seen` and in no other, and the remainder
`seen - running - completed` read as "not started yet". A run that had lost half
its agents looked healthy.

Observed live on `wf_6b0efc9300ac45fa` (four analyses, launched against
`/Users/yuqiang/work/code/agents`): `a1` (ZCode) and `a3` (opencode) died with
`Connection error.`, and the status line for that run was

```
    agents: 5 seen, 1 running, 2 completed
```

Four of the four analyses had reached a terminal state — two done, two dead — and
the line described neither death. The reader's only correct inference from it was
wrong: that two agents had not started yet. The truth was recoverable, but only by
reading `journal.jsonl` or the per-agent `status` in `progress.json` by hand,
which is the extra step that makes a failure invisible in practice.

Two things produced it.

**`completedAgents` is the only completion count the snapshot carries.**
`snapshot()` counts `completed` and `cached` and nothing else, so the renderer had
no failed count to draw on even though every `WorkflowProgressAgent` already
carried `status: "failed"`. The buckets were the renderer's choice; the counts
were not available.

**The reason lived on a different surface.** `WorkflowProgressAgent` had no
`error` field, so a failed agent's reason existed only in the journal. The
snapshot's `message` does hold the failure text at the moment it happens, but
`message` is the *last event* and the next `emit` overwrites it — so it cannot
survive to the moment a reader actually looks.

## Decision

Count every terminal agent state, name the ones that stopped, and carry the
reason on the record.

- **`failed` and `aborted` are buckets.** `renderLiveStatus` counts them from
  `progress.agents` and appends them only when non-zero, so a healthy run's line
  is byte-for-byte what it was.
- **A stopped agent is named, not just counted.** A second line gives each
  `id`, its `label`, and its reason: `failed: a1 "analyze-ZCode" (Connection
  error.)`. The count says the run degraded; the id says whether to stop it,
  resume it, or ignore the loss.
- **The reason travels on the snapshot.** `WorkflowProgressAgent` gains an
  optional `error`, set in the orchestrator's failure branch *before* `emit`, and
  bounded to 160 chars so one long error cannot bulk up `progress.json`. The
  renderer bounds it again on display.

## Alternatives considered

**Count the buckets without naming the agents or carrying the reason.** The
smaller change, and it leaves the reader with "2 failed" and no way to tell a
schema mismatch (retryable, cheap) from a provider outage (not). Naming the id is
what makes the count actionable, and the reason is what makes it diagnosable;
collecting both is one field and one line.

**Render a single `degraded: true` flag on the run.** A verdict, not a fact, and
the sibling note on this surface already rejected verdicts for the same reason:
the honest evidence is the ages and the counts, and the judgement is the reader's.
A count cannot lie; a threshold can.

**Reuse the existing `message` field instead of adding `error`.** `message` is the
last progress event, overwritten by the next phase, log, or agent start. A reader
who looks thirty seconds after the failure sees a healthy-looking run — the same
defect, moved down a layer.

**Show every agent in the status.** A wide fan-out would bury the two facts that
matter under the ones that do not. Both lists are bounded to the terminal-failure
states.

## Consequences

A degraded run is legible from the model-facing status alone. The reason is on
`progress.json` too, so the same question is answerable from a run directory after
the session that owned it is gone, rather than only from the journal.

`progress.json` gains an optional per-agent `error`. It is an additive field on a
best-effort snapshot that `readProgressSnapshot` already parses loosely, and
existing files without it stay valid.

The rendered buckets changed shape when — and only when — something failed: a run
with no failures renders exactly the string it did before, so no existing pin
moved.

`aborted` is counted and named like `failed`, though the orchestrator marks a
stopped agent `failed` today, so an agent-level `aborted` is not reachable through
the current path. It is rendered because the type admits it; that the type admits
a state nothing produces is a separate question, not one this change settles.

## Verification

- `plugins/workflow/test/live-status.test.ts` — "names a failed agent instead of folding it into the pending remainder" and "counts an aborted agent separately from a failed one"
- `plugins/workflow/test/orchestrator.test.ts` — "a failed agent carries its reason into the live progress snapshot"

The third is the wiring half: the renderer can only name a failure the snapshot
carries, and without an orchestrator-level assertion the field could be added to
the type and never populated — correct rendering over an always-empty input.

`221 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: two red runs, one per half of the change.

- **The failed/aborted buckets removed from the count** (the original defect). It
  failed the two renderer tests on their exact strings. The first received
  `agents: 3 seen, 1 running, 1 completed` for a run with three agents of which
  one was dead — the dead one accounted for by nobody. This was also the state the
  test was written against: it was added before the fix and failed on the unfixed
  renderer with that line, then passed once the buckets existed.
- **The error assignment stubbed in the orchestrator's failure branch** (the
  reason never entered the snapshot). It failed the orchestrator test with
  `Expected to contain: { status: "failed", error: "provider exploded" }`.
  Restoring the line returned it to green, so the test pins that the snapshot is
  populated rather than that the renderer could print a field.
