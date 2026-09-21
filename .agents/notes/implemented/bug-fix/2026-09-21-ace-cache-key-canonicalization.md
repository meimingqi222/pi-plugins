# Agent Note: The ACE index key hashes a canonical project root

Status: implemented

## Problem

Both index files are named after a hash of the project root:

```ts
export function acemcpCachePath(dataDir: string, projectRoot: string): string {
  return join(dataDir, "cache", `${sha256Short(projectRoot)}.json`);
}
export function piAceIndexPath(dataDir: string, projectRoot: string): string {
  return join(dataDir, "pi-ace-index", `${sha256Short(projectRoot)}.json`);
}
```

`sha256Short` hashes the string it is handed, so two spellings of one directory
produce two different index files. `runAceSearch` passed its `projectRoot`
straight through:

```ts
const { projectRoot, query, config } = options;
```

`acemcp` hashes the POSIX-absolute form — `normalizePath` is
`filepath.Abs` followed by `strings.ReplaceAll(path, "\\", "/")`, and
`getCachePath` then hashes that. Nothing on the client side enforced the same
form. On Windows a native root reaches `runAceSearch` as `C:\proj` from any
caller that did not go through `toPosixAbsolutePath`, which hashes to different
bytes than `C:/proj`.

The cost is the exact cost this plugin exists to remove. A differently-spelled
run reads a store that does not exist, computes `missing.length` over the whole
project, and re-uploads everything `acemcp` had already indexed. The bug is
silent in the same way the ranking bug was: retrieval still returns results, so
the extra upload reads as slowness rather than a lost index.

It was also invisible to the test suite. `test/search.test.ts` seeded its store
with `piAceIndexPath(dataDir, root.split("\\").join("/"))` — the POSIX spelling
— while passing the native `root` to `runAceSearch`. The mismatch that made the
bug a bug was written into the test as setup, so the four end-to-end warm-run
cases were red on Windows and green on POSIX.

## Decision

`runAceSearch` canonicalizes once, at the entry point, before any path is hashed:

```ts
const projectRoot = toPosixAbsolutePath(options.projectRoot, process.cwd());
```

`toPosixAbsolutePath` already existed for exactly this purpose and is what the
CLI (`src/cli.ts`), the pi tool (`src/index.ts`) and the accuracy bench
(`bench/accuracy.ts`) call before `runAceSearch`. Moving it inside the function
makes the contract hold for every caller instead of only the three that
remembered.

The function is idempotent (`toPosixAbsolutePath` of an already-POSIX-absolute
path returns it unchanged), so the existing callers are unaffected: their input
is passes through as the same string.

## Alternatives considered

**Fix the tests only.** The four red tests would go green, but the underlying
asymmetry would remain: any future caller that skips the helper silently gets a
cold index. The tests encoded the bug rather than catching it, so repairing them
would have removed the only signal.

**Canonicalize inside `acemcpCachePath`/`piAceIndexPath`.** Both functions are
pure path builders with no notion of a working directory, and `toPosixAbsolutePath`
needs a `cwd` to resolve a relative root. Threading one through would make two
small helpers depend on process state. Canonicalizing once at the boundary is
cheaper and keeps `projectRoot` a single well-defined value for the rest of the
run.

**Hash a case-folded or symlink-resolved path.** Broadens the change beyond the
observed defect. `acemcp` does neither, so matching it means matching
`filepath.Abs` + separator replacement and nothing more. A case- or
symlink-normalized key would also stop agreeing with the cache `acemcp` built,
which is the whole reason this client reads that cache.

## Consequences

- A project reached by any spelling of its root now maps to one index, so the
  warm path cannot be defeated by a trailing `/.`, a `..` segment, or a
  different separator.
- The key still matches `acemcp`'s, because the fix uses the same
  normalization `normalizePath` performs. A cache `acemcp` wrote is still read.
- `runAceSearch` resolves a relative `projectRoot` against `process.cwd()`,
  where it previously hashed the relative string. Callers that pass a relative
  root get the intended absolute key; callers that pass an absolute one see no
  change.
- The four existing warm-run tests now pass on Windows without being rewritten,
  which is the evidence that they were testing setup, not behavior.

## Verification

- `plugins/ace-search/test/search.test.ts` — "the cache key is canonical, so a
  redundant spelling finds the same index" (a run seeded through one spelling is
  warm for a second spelling), plus the four end-to-end cases it protects: "a
  warm index uploads nothing and skips the upload phase", "waitForIndex is
  skipped when there was nothing to upload", "a file known only to this client's
  index is not re-uploaded", "both stores contribute: the union is warm".
- `plugins/ace-search/test/config.test.ts` — the `toPosixAbsolutePath` contract
  the fix relies on, pinned platform-appropriately rather than against POSIX
  literals that are drive-relative on Windows.
- `plugins/ace-search/test/index-store.test.ts` — the cache-path scheme, with
  the directory joined the platform's way: only the hash and file name are
  `acemcp`'s contract, the separator belongs to the filesystem.

Proved: reverting `runAceSearch` to `const projectRoot = options.projectRoot`
made the new canonical-key test fail along with the four warm-run cases
(5 fail / 9 pass in the file). Restored, 70/70 across the plugin.
