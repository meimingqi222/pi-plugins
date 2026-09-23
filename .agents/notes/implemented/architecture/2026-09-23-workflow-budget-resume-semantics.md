# Agent Note: A workflow budget bounds one execution, not a resume chain

Status: implemented

## Problem

`RunBudget.restore` documented itself as "Used on resume: the admission counter
must come back, or a resumed run would get a second full agent budget and could
double its original spend." Nothing called it. The tool's `budget` parameter was
described as a budget "for the whole run", and `resumeFromRunId` resumes a run, so
three artifacts implied a semantics the code did not implement:

- the method's comment claimed a call site that did not exist,
- the parameter's description said "the whole run" where the code meant one
  execution,
- and a reader had no way to tell whether a resume inherited the earlier run's
  spend or started fresh.

This surfaced during a design review, where it was reported as "resume resets the
budget" — a defect. It is not one; it is an unmade decision wearing the clothes of
a made one.

## Decision

**A budget bounds one execution.** A resume is a new run with its own `budget`
argument, and the parameter means what it says. A reused call costs nothing, so it
releases the slot it was admitted (see
`2026-09-23-workflow-unenforced-guarantees.md`), and the new execution's budget
covers the work the new execution does.

`restore` stays, and its comment now states what it is: the seam for the other
choice, not a claim that the choice was made. `exhausted` stays for the same
reason. Deleting either would shrink a diff at the cost of an API another consumer
may want, and the earlier instinct to delete them was wrong for that reason.

The parameter description and the README now say "this run", so the surface stops
advertising the semantics it does not have.

## Alternatives considered

**Carry the budget across a chain, by wiring `restore`.** The other coherent
choice, and it needs more than a call site:

- The counters must be **persisted per run**, because the previous run's result is
  held in the in-memory `RunRegistry` and does not outlive the session. A chain
  resumed after a restart would silently start from zero — the same bug in a
  harder-to-see place.
- Summing the previous run's journal is **not** a substitute: a resume that
  diverges at call 5 of 40 re-runs 35 calls, and the journal records those once
  while the chain paid for them twice. The seed has to be the carried counters, not
  a re-derivation.
- It changes user-visible behavior in a way that can be hostile: a resume under the
  same number grants nothing, because the chain already spent it, so the user gets
  a run that refuses every call and must raise the budget to make any progress.

That is a bounded piece of work — persist `RunBudgetState` in `progress.json`,
read it on resume, call `restore` — and it is deliberately not done here. It is a
product decision about whether a budget is a per-call or per-piece-of-work bound,
and the honest default is the one that needs no new state and no surprise.

**Make `budget` per-execution but document nothing.** What the code did before.
It left the resolution of a genuinely ambiguous question to the reader's
assumption, which is how the review came to report a defect.

**Delete `restore` and `exhausted` instead.** Tried first, and reverted. The
absence of a consumer is not evidence that an API is wrong; here it was evidence
that a decision had not been made. Removing the seam would make the decision
*harder* to revisit, not easier.

## Consequences

A caller can predict the budget: it bounds the calls the tool call makes, no
matter how many times the same script is resumed. That is the smaller surprise,
and it is what the code already did.

The total spend across a chain can exceed any single call's `budget`, because each
resume is priced on its own. A caller who wants a per-piece-of-work bound must
raise it deliberately or pass the remaining amount — which the plugin does not
compute for them.

The plugin still reports the facts needed for either policy: every run's
`spentTokens` and `agentCalls`, and now `overspent`/`refused`. If the chain
semantics is chosen later, the reporting is already in place and only the seeding
is missing.
