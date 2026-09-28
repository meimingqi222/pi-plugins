# Agent Note: Resume matches on call content, not request order

Status: implemented

## Problem

Resume was position-keyed (inherited from Step-Code): `ResumeLog` looked up a
call by its sequence index plus hash, and a single mismatch disabled reuse
for the rest of the run — forever. In `pipeline()`/`parallel()`, tasks that
`await` before their next `agent()` call issue requests in *completion*
order, which is timing-dependent; and on resume, cached calls resolve
instantly and reorder the stages behind them. A parallel run therefore
missed every call past the first timing difference and re-ran the rest of
the script live. A second defect compounded it: the journal appends entries
at completion time, so a parallel run's file held out-of-order seqs, and
`WorkflowJournal.load` truncated at the first non-monotonic seq — offering
only the first entry as replay input.

## Decision

**Content-addressed reuse with occurrence counting.**

- `ResumeLog` indexes the previous run's reusable entries (`completed` or
  `cached`) by `callHash` into FIFO lists ordered by original `seq`.
  `cached()` pops the next unused entry for that hash — the nth identical
  call pairs with the nth identical entry, so two identical prompts are
  still two calls. A miss consumes nothing and disables nothing: a call
  whose prompt depends on earlier output simply has a different hash.
- A hash covers all of a call's inputs (prompt and options), so a match is a
  legitimately reusable answer no matter which request slot it occupies.
- The new run's `seq` stays in the journal as its own request index.
- `WorkflowJournal.load` still truncates at the first unparseable line and
  at a sequence gap — but sorts by `seq` first, because out-of-order seqs
  are the *normal* shape of a parallel run's journal, not corruption.
- Docs: the README's "Prefix-only resume" section is now
  "Content-addressed resume", and ATTRIBUTION records the divergence.

## Alternatives considered

- **Keep seq-keyed reuse and force deterministic ordering.** Not possible
  without serializing `parallel()` — the order is the timing.
- **Hash-only lookup with a Set (no occurrence counting).** Would serve the
  same entry for two identical calls; counting occurrences preserves call
  identity.
- **Keep "disable on first miss".** A miss under content addressing is just
  a new call; disabling would re-create the old bug one level down.
- **Buffer journal appends and flush in seq order.** Reordering at read
  (load sorts) achieves the same contiguous-prefix guarantee without
  holding completed-call records in memory until later calls finish.

## Consequences

Resume now works for parallel/pipeline scripts where it previously
re-ran nearly everything. A call that failed in the earlier run is still
never reusable. `disable()` is retained for a caller that detects its own
divergence, but nothing in the current codebase calls it.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — "workflow resume" block:
  a 3-task parallel script with reversed completion order on resume executes
  **zero** live calls; a script calling an identical prompt 3× against a
  2× journal runs exactly one live call; one changed prompt runs live while
  the surrounding calls reuse.
- `plugins/workflow/test/core.test.ts` — `ResumeLog`: order-independent
  reuse, miss-doesn't-disable, FIFO occurrence pairing, failed entries not
  reusable.
- `plugins/workflow/test/journal.test.ts` — the reader tests pin sorted
  truncation at a real gap.

Proved: with `plugins/workflow/src/core/journal.ts` and `plugins/workflow/src/runs/journal.ts` reverted, the
new parallel test ran five of six calls live (`live = ["A1","A2","B_0:…",
"B_2:…","B_1:…"]`), the order-reuse unit test failed, and the updated
existing resume test contradicted its own name (`59 pass, 3 fail`). After
the fix: `62 pass, 0 fail` across the three files.
