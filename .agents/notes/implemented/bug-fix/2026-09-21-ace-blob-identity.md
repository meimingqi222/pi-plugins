# Agent Note: Blobs are addressed by hash for retrieval and by name for upload

Status: implemented

## Problem

The ACE retrieval API does not use one identifier for a blob. Copying the
endpoints from `acemcp-go`'s `internal/scanner/scanner.go` produced a client that
posted correct-looking payloads and got `HTTP 400 {"error":"Invalid blob
name"}` from `/agents/codebase-retrieval`, while `/batch-upload` worked fine.

The three endpoints disagree:

| Endpoint | Field | Identifier |
| --- | --- | --- |
| `/batch-upload` | `blobs[].path` | blob **name**, e.g. `a.ts#chunk2of5` |
| `/find-missing` | `mem_object_names` | blob **hash** |
| `/agents/codebase-retrieval` | `blobs.added_blobs` | blob **hash** |

`acemcp-go` makes the distinction only implicitly, and only in call sites that
happen to be far apart: `getProjectBlobs` reads the cache's `meta.Hashes` for
retrieval, while `uploadBatch` reads `chunk.ChunkPath`. The naming in both places
is generic (`blobs`, `blobNames`), so nothing at either call site signals which
of the two identifiers is expected. A client written from the Go source reads
naturally and gets it wrong.

The mistake was not caught by any unit test, because the tests that existed
asserted the client's own shape rather than the identifier semantics.

## Decision

- `AceClient` documents the distinction in one place, on the interface, with the
  endpoint table.
- `search()` and `findMissing()` take **hashes**; `uploadBlobs()` takes **names**.
  The parameter names say which: `hashes` on the two read paths, `path` on the
  upload path, and `BlobInventory` exposes `names` and `hashes` as separate
  arrays computed in one walk.
- `BlobInventory.missing` is keyed on **hash** mismatch, since the server's
  notion of "has this body" is the content-derived hash.

Deriving both lists from one inventory pass also removed a latent double walk:
resolving the hash store before walking means the store is in memory for the
whole run, so nothing downstream re-reads or re-hashes the workspace.

## Alternatives considered

**Send names everywhere.** Confirmed wrong against the live endpoint: retrieval
rejects a name. Names are a client-side convention (`path#chunkNoftotal`); the
server indexes chunks by content hash, which is why a rename does not re-upload.

**Send hashes everywhere.** `/batch-upload` keys its write on `path`; the server
cannot associate a bare hash with a file, and a first-time index would have no
blob to attach content to.

**Normalize to one identifier in a wrapper.** Would hide a real protocol
asymmetry behind a type that claims the two are interchangeable, which is the
belief that caused the bug.

## Consequences

- A warm run reuses `acemcp`'s cache exactly: 4428 files / 6031 chunk hashes were
  verified byte-identical, so the first search after installing this client
  uploads nothing.
- `acemcp-cache` stores `filePath → [hash]` with no chunk names, so names are
  reconstructed with the same `#chunk{N}of{TOTAL}` rule the chunker uses. If the
  file changed since `acemcp` hashed it, the reconstructed names describe the old
  split — harmless, because the name/hash pair then disagrees with the freshly
  computed chunk, so it is reported missing and uploaded. A stale store can cause
  an extra upload, never a skipped one.

## Verification

- `plugins/ace-search/test/client.test.ts` — "uploadBlobs posts names under
  `path`, never hashes", "findMissing posts hashes under `mem_object_names` and
  reads both lists", "search sends hashes in added_blobs and the exact legacy
  envelope".
- `plugins/ace-search/test/search.test.ts` — "a cold project uploads every
  chunk, then retrieves with hashes" asserts the retrieval payload is a 64-char
  hex digest and explicitly **not** the chunk name; "waitForIndex polls
  find-missing with hashes, not names".
- `plugins/ace-search/test/index-store.test.ts` — "matches acemcp's
  sha256(absPath)[:16] scheme", pinned to the literal
  `0de615464bc64794` observed for this workspace, plus the single-chunk case
  (no `#chunk1of1` suffix, matching `acemcp`).

Proved red: reverting the retrieval payload to `inventory.names` reproduced
`Invalid blob name` against the live endpoint and failed the cold-project
assertion. The identifier check is what the live 400 replaced.
