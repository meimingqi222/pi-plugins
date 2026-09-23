# Agent Note: Stop billing a resumed run for work it reused

Status: implemented

## Problem

A fully-resumed workflow reported `spentTokens: 18` when it had spawned no
process and made no model call. The cached branch added the previous run's usage
to the current run's total:

```ts
usage = addUsage(usage, cached.usage);
```

Two things were wrong with that, and only one is cosmetic.

**It disagreed with the budget.** `budget.record()` is only called on the live
path, so the budget correctly saw a resumed run as costing nothing while
`spentTokens` said otherwise. A run could report a large spend and still be
admitted for its full budget — the two counters described different runs.

**It hid the point of resume.** `spentTokens` answers "what did this cost me".
The whole reason to resume is that the answer is zero. Reporting the reused
total makes a successful resume indistinguishable from a re-run, which is the
one number a user checks to decide whether resume worked.

## Decision

The cached branch no longer touches the run's `usage`:

```ts
record.usageTokens = workflowUsageTokens(cached.usage);
```

The reused call's own size is still reported per agent, so a reader can see how
much work the cache saved, and `cacheHits` counts the reuse. What changed is that
the *run total* is now strictly what this run was billed.

## Alternatives considered

**Keep the total and rename it.** `spentTokens` becoming "tokens represented"
would need every reader to re-interpret it, and the budget comparison would still
be wrong.

**Add a `savedTokens` field.** The information is already available as
`cacheHits` plus each agent's `usageTokens`. A third counter with no consumer is
speculative.

**Leave it and fix the test.** The test was asserting the behaviour a user
expects; the implementation was the thing that was wrong.

## Consequences

A resumed run reports `spentTokens: 0`, which matches both its budget and the
reason it was resumed. Per-agent `usageTokens` on cached entries still shows the
size of the reused work, so nothing is lost from the progress view.

## Verification

- `plugins/workflow/test/end-to-end.test.ts` — the resume test asserts
  `cacheHits: 1` **and** `spentTokens: 0`.
- `plugins/workflow/test/orchestrator.test.ts` — the orchestrator-level resume
  tests, unchanged.

Proved: folding the cached usage back in (`usage = addUsage(usage,
  cached.usage)`) failed `plugins/workflow/test/end-to-end.test.ts`'s "a resumed
run reuses a journaled call instead of spawning again" at the `spentTokens`
assertion with `Expected: 0, Received: 18`, then passed again after the line was
removed.

The end-to-end suite is what found it: it spawns a real agent process through a
fixture (`plugins/workflow/test/fixtures/fake-pi.mjs`) that speaks pi's JSON
event stream. Every earlier resume test stubbed the executor, so none of them
could observe a run that spawned nothing while reporting a spend.

Full workspace after the fix: `515 pass, 0 fail` across 36 files.
