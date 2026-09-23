# Agent Note: Report what the budget did, not only what was spent

Status: implemented

## Problem

A run reported `spentTokens` and nothing else about its budget. That single number
cannot answer the two questions a caller actually has, and both were recoverable
only by reading the journal:

- **Was the limit crossed?** A token budget is passive — admission checks the
  budget already spent, because the next call's cost is unknown — so a run can
  exceed its limit and still finish. `RunBudget` tracked this as `overspent`, and
  nothing read it, so a run that spent 130k against a 100k budget reported
  `status: "completed"` with `spentTokens: 130000` and no indication that the
  number it was given had been exceeded.
- **Was work turned away?** A refusal surfaced as `"1 agent call(s) failed"`. When
  the refusal happened inside a barrier it became `null` and the script carried on,
  so a degraded run finished with a generic reason and the actual cause
  (`Run agent budget exhausted (2/1)`) lived only in `journal.jsonl`'s `error`
  field. That is the same "the truth is recoverable but nobody recovers it" shape
  as the two earlier observability defects on this surface.

`WorkflowProgress.status` also declared a `budget_exceeded` member that nothing
ever assigned, so the type advertised a distinction the plugin did not make.

## Decision

- **`RunBudget.refused`.** A new getter set when `admit()` or `check()` turns work
  away. It is the complement of `overspent`: overspent crossed the limit after
  admission, refused was stopped before starting, and they settle differently. It
  is tracked inside the budget rather than inferred from errors because the type
  is lost on the way out — a refusal raised in the host arrives at the orchestrator
  as a plain string.
- **Both facts ride on `stopReason`.** `finish()` composes the script's reason with
  the budget's own, rather than letting one displace the other: a run can fail for
  a script reason *and* have overspent. `stopReason` is what
  `renderWorkflowResult` delivers, so the fact reaches the caller.
- **`budget_exceeded` is produced.** A run that settled `failed` *because the
  budget refused work* now reports `budget_exceeded` as its progress status. A run
  that merely overspent still reports `completed`: the overspend is in the reason,
  and changing the status too would put the two surfaces in disagreement.
- **`WorkflowRunStatus` admits it.** The `/workflows` path casts a snapshot's
  status to that union, so the member had to exist there or the cast would produce
  a value the type does not allow.

`RunBudget.overspent`, `.exhausted` and `.restore` are left in place. They are the
budget's API, not leftovers: `.restore` is the seam for a budget that spans a
resume chain (see `2026-09-23-workflow-budget-resume-semantics.md`), and deleting
an API to shrink a diff is not a simplification.

## Alternatives considered

**Derive the refusal from the failure count.** `failures > 0` already exists and
would have been a one-line change. It conflates a provider outage, a schema
mismatch and a budget refusal — three causes with different responses — and it
cannot see a refusal that a barrier swallowed.

**Report the budget by matching `RunBudgetExceeded` in the catch.** The refusals
that matter are raised in the host, which converts them to `reply.error` strings,
so by the time the orchestrator sees them the type is gone. Matching on message
text would be a second source of truth for what a refusal is.

**Make `budget_exceeded` the status for an overspent run too.** A run that crossed
a passive token limit and completed is a completed run; calling it
`budget_exceeded` puts its status and its result in conflict. Two facts, two
places that can each hold one honestly.

**Add the budget facts to `WorkflowRunSummary` for `/workflows`.** The on-disk
summary is journal-derived and would need a third source of the same numbers. The
result already carries them, and `/workflows` is the listing, not the report.

## Consequences

A caller no longer has to open a journal to learn that a bound was hit. The
delivered result's `stopReason` names it, and a budget-stopped run's progress
status distinguishes it from an ordinary failure.

`stopReason` can now contain two clauses (`"script blew up; agent budget refused
further calls"`). It was already free text; the change is that it is no longer
exclusive.

A run that overspends still reports `completed`. That is deliberate and is the
reason the overspend is in the reason string rather than the status — but it does
mean a caller ignoring `stopReason` sees no difference between a run inside its
budget and one past it.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — a budget-stopped run names the
  refusal in `stopReason` and settles as `budget_exceeded`; an overspent run
  completes with `token budget exceeded (130 spent)` in its reason
- `plugins/run-core/test/run-core.test.ts` — `refused` and `overspent` are set
  independently, and a run that spends exactly its budget reports neither

`238 pass, 0 fail` for the workflow package and `25 pass` for `pi-run-core`;
`bun run typecheck` clean.

Proved: two red runs, one per half.

- **`budgetNotice()` returning early.** It failed
  `workflow observability on disk > a run the budget stopped reports that, and a
  run that merely overspent still completed`, receiving the bare
  `Run agent budget exhausted (2/1)` — which is precisely the old behavior: the
  cause exists but only in the script's error string.
- **The `budget.refused` branch removed from `settleProgress`.** It failed the
  same test with `Expected: "budget_exceeded", Received: "failed"`, so the
  assertion pins the status and not merely the reason.

Restoring each returned the suite to green.
