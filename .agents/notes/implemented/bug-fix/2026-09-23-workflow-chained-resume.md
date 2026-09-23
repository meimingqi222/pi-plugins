# Agent Note: Record a cache hit in the new journal so resume can chain

Status: implemented

## Problem

`resumeFromRunId` reuses the journaled prefix of a previous run. On a cache hit
the orchestrator returned the reused value and *did not* write anything to the
new run's journal — the only `journal.append` calls were for a live success and
(for failures) the failure path. So a run that was itself a resume produced an
empty or gapped journal.

`WorkflowJournal.load` reads a journal as a contiguous sequence: it stops at the
first gap. A second resume chained off the first therefore found no usable
prefix and executed everything live, paying again for work that had already been
bought. Chaining `resumeFromRunId` twice silently degraded to no resume at all.

The failure is quiet by construction: the second resume still produces the right
answer, just at full cost. Nothing in the result distinguishes "reused the whole
prefix" from "re-ran the whole prefix" except `spentTokens` and `cacheHits`,
which is exactly what the test pins.

## Decision

Write the reuse into the new run's journal as a `status: "cached"` entry,
carrying the reused result, usage, and `callHash` from the previous entry.

- The new journal is then contiguous, so a later resume can reuse it in turn.
- `cached` is reusable (`isReusable` accepts it), so the chained entry can stand
  in for execution exactly as the original `completed` entry did.
- The sequence number is the current call index, which equals the previous run's
  index for the reused prefix.

## Alternatives considered

**Copy the previous journal into the new run on open.** Records calls that this
run may never reach if the script diverges early, and would then present work
this run did not do as part of its own prefix.

**Make `load` tolerate gaps.** That removes the property the reader exists for: a
hole in the sequence is how a partially written journal is detected, and a
tolerant reader would replay a prefix that was never contiguous.

**Only journal the cached entry when the entire prefix is cached.** A partial
prefix is the normal case (the reuse stops at the first divergence), so this
would still leave gaps in the common case.

## Consequences

A run resumed from a resumed run keeps its cache, so chaining is free rather than
quadratic in the number of resumes. The new run's journal now lists reused calls,
so a reader sees `cached` entries alongside `completed` ones; `readRunSummary`
already counted `cached` as an agent call, which stays accurate.

The journal grows by one line per reused call, which is bounded by the script's
call count.

## Verification

- `plugins/workflow/test/end-to-end.test.ts` — the `chained resume` case runs a script, resumes it, resumes *that*, and asserts the third run still reports one cache hit, zero billed tokens, and a single `cached` entry in the middle run's journal.

`202 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: disabling the cached append (guarding it with `await false &&`) failed
exactly
`chained resume > a second resume chained off the first reuses the prefix again`
with `Received: 0` for `cacheHits`, which is the re-run the fix prevents.
Restoring the append returned it to green.
