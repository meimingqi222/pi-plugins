# Agent Note: Enforce pi-paste-image's aggregate cap before the read

Status: implemented

## Problem

`attachImageReferences` checked `totalBytes + bytes > DEFAULT_MAX_TOTAL_BYTES`
**after** `await loadSafely(...)` had already read and base64-encoded the
file. The cap therefore bounded what was retained, not the I/O or transient
memory it was supposed to bound. A probe with 20 references to 24 MiB images
made 20 full reads and allocated roughly 350 MB to attach one image. The
`break` also left only the inner candidate loop, so every later reference was
still read.

The regression test added with the original cap used a stub loader returning
an in-memory base64 string, so it measured arithmetic and could pass with the
real loader removed.

## Decision

Add `size(filePath)` to `AttachEnv`, implemented over `stat` before any read.
The aggregate check now runs before `load()`, and exhaustion stops the outer
reference loop. The post-load byte check is retained as a re-check because the
file may grow between `stat` and `read`.

## Alternatives considered

**Read with a capped stream.** More precise for a file that grows during the
read, but the loader is pi's own image path and accepts a whole file; adding
a second read path would duplicate its MIME validation.

**Drop the post-load check.** Leaves a TOCTOU window where a file that grew
between stat and read is attached over budget.

## Consequences

Missing files are no longer passed to `load()` at all: `size()` returns
`undefined` and the candidate is skipped. The existing test that asserted
both the cwd candidate and the temp candidate reached `load` was updated to
expect only the existing one. The aggregate test now counts reads and asserts
one read and one refusal.

## Verification

- `plugins/paste-image/test/attach.test.ts` — "the aggregate attachment bytes
  are bounded before the read" asserts `loads === 1` and `sizes === 2` for
  three references; "resolves a bare filename out of pi's temp directory"
  pins the skip-without-read behaviour.

Proved: with `plugins/paste-image/src/attach.ts` and `plugins/paste-image/src/index.ts` restored, the
aggregate test fails (all three references reach `load`, so `loads` is 3
instead of 1), and the temp-directory test fails because the missing cwd
candidate is passed to `load`.
