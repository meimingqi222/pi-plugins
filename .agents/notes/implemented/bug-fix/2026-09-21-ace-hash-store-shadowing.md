# Agent Note: A blob known to only one hash store was re-uploaded forever

Status: implemented

## Problem

`pi-ace-search` reads blob-hash manifests from up to three places and used to
**rank** them, taking the first non-empty one:

```ts
const candidates = [config.indexPath, acemcpCachePath(...), piAceIndexPath(...)];
let best = await loadBlobHashStore(candidates[0]!);
for (const path of candidates.slice(1)) {
  if (best.entryCount > 0) break;      // ← stops as soon as one is non-empty
  const candidate = await loadBlobHashStore(path);
  if (candidate.entryCount > best.entryCount) best = candidate;
}
```

On a machine where `acemcp` has ever run, `~/.acemcp/data/cache/<hash>.json`
exists, so the loop broke on the first candidate and **this client's own index
was never read**.

The two stores are written by different processes and go stale independently:

- `acemcp`'s cache is a snapshot taken by another program. It is never updated
  when this client uploads something.
- `pi-ace-index` records only the runs this client performed. It is absent on a
  fresh machine where only `acemcp` has indexed the project.

So the failure is: **add a file, run a search, and every subsequent search
re-uploads it.** The file is in `pi-ace-index` (written by this client) but the
lookup reads `acemcp`'s cache, which predates the file, concludes the chunk is
missing, uploads it again, and writes the same index it already had.

Reproduced against the real workspace before the fix:

```
run 1: [ace] upload: Uploading 1 of 6032 blobs   uploaded: 1
run 2: [ace] upload: Uploading 1 of 6032 blobs   uploaded: 1   ← should be warm
```

Entry counts did not reveal it: `acemcp-cache` held 4428 entries and
`pi-ace-index` 4429, so even ranking by size picks the stale store. The counts
differ by exactly the number of changed files, which is the information that
matters and the one a count comparison discards.

This contradicted the module's own contract:

> `pi-ace-index` … Read *and* written, so uploads made here stay warm even when
> acemcp's cache is absent or stale.

"Absent" held. "Stale" did not.

## Decision

Replace ranking with a **union**. `mergeHashStores` combines every candidate:

- A name is warm if **any** store has it.
- A name present in two stores with **different** hashes is dropped, so the
  caller re-uploads it. Two stores disagreeing means at least one describes an
  older revision, and re-uploading is safe while skipping an upload is not —
  the same asymmetry the module already documented for a single stale store.
- Empty stores contribute nothing and cannot create conflicts.
- A conflict on one name does not discard the others.

`IndexStoreFormat` gains `"merged"` for the multi-store case. When no store has
content the result reports the first candidate's own format, so the diagnostic
still names the file that was consulted.

`entryCount` counts **files**, not chunks, so it stays comparable with
`loadBlobHashStore`.

## Alternatives considered

**Prefer `pi-ace-index` by path order.** Fixes the reported case but breaks the
opposite one: on a fresh machine this client's index is empty, and preferring it
would discard the warm `acemcp` cache and re-upload the entire project.

**Compare `updatedAt` and take the newest store.** Only `pi-ace-index` has that
field; `acemcp`'s cache carries no timestamp in a form this client can compare,
so the two cannot be ordered. It would also make the whole result depend on one
file's clock rather than on what is actually known to be uploaded.

**Merge but keep the newest hash on conflict.** Guessing which store is newer is
exactly what is unavailable, and guessing wrong skips an upload the server never
received — the one failure mode that corrupts the index rather than costing a
redundant request.

**Delete `acemcp`'s cache to remove the ambiguity.** Destroys a shared file that
another running process owns, and this repository already has a note about the
consequences of removing files from `~/.acemcp`.

## Consequences

- A file uploaded by this client stays warm even while `acemcp`'s cache exists
  and is stale — the reported bug.
- A project indexed only by `acemcp` still reuses that work, so the warm start
  this plugin was built for is preserved.
- A changed file whose old hash is recorded in one store and new hash in the
  other is re-uploaded once. Correct, and self-correcting: the next run has both
  stores agreeing.
- Store selection is no longer order-dependent, so adding a fourth candidate
  cannot silently shadow the others.

## Verification

`plugins/ace-search/test/index-store.test.ts` — eight cases for the merge:
union of disjoint names, agreement stays warm, disagreement drops the name,
a conflict does not discard unrelated names, empty stores are inert, a single
non-empty store passes through, no stores does not throw, and `entryCount`
counts files rather than chunks.

`plugins/ace-search/test/search.test.ts` — end to end through `runAceSearch`:
"a file known only to this client's index is not re-uploaded" (the reported
bug), "both stores contribute: the union is warm" (two files, each known to a
different store), and "a hash disagreement between the stores forces a
re-upload".

The previous test `acedmp's cache is preferred over this client's own index`
asserted the ranking as intended behaviour and was replaced. It encoded the bug:
it only checked that a cache-only project uploads nothing, which the union also
satisfies, so it never covered the case where the two stores hold different
files.

Proved: restoring the ranking loop makes 3 tests fail, including the reported
case. Restored, 69/69 pass.

Verified against the real workspace, which is the environment that exposed it:

```
run 1: [ace] upload: Uploading 1 of 6032 blobs   uploaded: 1   ← new file
run 2: [ace] upload: Index is warm; nothing to upload  uploaded: 0
run 3: [ace] upload: Index is warm; nothing to upload  uploaded: 0
```

Before the fix every run re-uploaded the chunk. The probe file was removed and
the target repository left clean.
