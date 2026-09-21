# Agent Note: A failed blob upload must not be recorded as indexed

Status: implemented

## Problem

The upload pass in `pi-ace-search` batches work by blob hash and treats a batch
failure as non-fatal, on the reasoning that retrieval still improves with the
chunks that did land. That reasoning is correct for the *current* search. It is
wrong for the persisted index.

`runAceSearch` wrote its index immediately after the upload pass, unconditionally:

```ts
const uploadedChunks = await uploadChunks(...);
await persistPiAceIndex({ entries: inventory.entries, ... });
```

`inventory.entries` describes the whole workspace, not the subset that uploaded.
So a run where a batch failed recorded the hashes of chunks the server had never
seen. Every later run read those hashes back as "already present", computed
`missing.length === 0`, and skipped the upload — forever. The index was
permanently wrong until the file's content changed.

The same defect swallowed authentication failures. `uploadChunks` caught every
per-batch error, logged it, and continued. With a 401, all batches fail, nothing
is uploaded, and the run reports success with `uploadedChunks: 0` while polling
the index it just failed to populate.

The failure was silent in both cases: retrieval still returns *something*, so the
degradation looks like a ranking problem, not a lost index.

## Decision

Two changes, each enforcement-level:

1. **Only a fully successful upload is persisted.** `uploadChunks` returns
   `{ uploadedChunks, failedBatches }`; the index write is gated on
   `failedBatches === 0`. A partially failed run leaves the previous index
   untouched, so the next run retries exactly what failed and uploads nothing
   extra. Skipping the write is strictly better than writing a partial index.

2. **Auth failures abort the run.** `isFatalAceError` (401/403) is rethrown
   instead of swallowed, consistent with the client, which already refuses to
   retry a 401. A 401 that repeats for every batch cannot become a success by
   trying the next batch.

Transient failures keep the documented behaviour: the batch is lost, progress is
reported, and retrieval proceeds. Losing a batch degrades results; it must not
invalidate them.

## Alternatives considered

**Upload exactly the successful chunks.** The honest fix in principle, but a
blob is not a unit of consistency here — retrieval takes the whole hash list for
the project, and a partially uploaded file yields chunks that reference each
other. Tracking per-chunk success would also make the index a record of a
*partial* run, and the next run would then have to distinguish "absent because
failed" from "absent because new". Leaving the old index intact needs no such
distinction.

**Retry failed batches until they succeed.** Turns a degraded run into a hang,
which is the failure mode this plugin was written to remove.

**Fail the whole search on any batch failure.** Throws away retrievable context
for a transient network blip.

## Consequences

- A failed run is retried in full on the next invocation rather than being
  silently skipped. The cost is repeated upload work after a partial failure;
  the benefit is an index that cannot lie.
- `uploadedChunks` now counts the chunks actually uploaded
  (`completed * batch.size` accumulated) instead of `batches × size`, which
  overstated the final partial batch.
- `runAceSearch` can now reject with a 401/403 instead of resolving. The CLI
  turns that into exit code 1 with the token hint; the pi tool lets it throw so
  the error flag reaches the model.

## Verification

- `plugins/ace-search/test/search.test.ts` — "a failed upload is not persisted,
  so the next run retries it" (index stays empty after a failure, and the retry
  re-uploads), "a successful upload is persisted and the next run is warm" (the
  positive side of the same gate), "a failing batch does not abort the run, but
  a 401 does".
- `plugins/ace-search/test/client.test.ts` — "a 401 fails immediately instead of
  burning retries".

Proved red: replaced the `outcome.failedBatches === 0` gate with `if (true)` →
"a failed upload is not persisted…" and "a failing batch does not abort the run,
but a 401 does" both failed. Removed the `isFatalAceError` rethrow in
`uploadChunks` → the 401 case failed. Reverted both; 56 tests across the plugin
passed.
