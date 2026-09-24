# Agent Note: Start readLogTail on a line boundary

Status: implemented

## Problem

`readLogTail(path, maxBytes)` seeks to `size - maxBytes` and reads to EOF.
When that offset lands mid-line — the common case for any log larger than
256KB — the returned text began with the tail of a truncated line, so
`bg_tasks log` showed a garbled first line that could be mistaken for real
output.

## Decision

When the read does not start at offset 0, drop everything up to the first
newline. A tail that is a single oversized line keeps its byte tail as-is —
there is no boundary to align to.

## Alternatives considered

**Seek backwards to the previous newline.** Equivalent result with an extra
read; slicing the already-read buffer is simpler.

**Leave it — the caller truncates anyway.** `bg_tasks log` passes the text
through `tailLines`, which only drops *whole* leading lines; the partial line
survived to the model.

## Consequences

A mid-file tail always begins on a line boundary. Files smaller than the
window and single-line tails are unchanged.

## Verification

- `plugins/bg-bash/test/logs.test.ts` — `readLogTail` cases pin the
  mid-line drop, the fits-entirely path, and the single-oversized-line path.

Proved: before the change, `readLogTail(path, 20)` on a three-line file
returned `d line\nthird line\n`; after it, `bun test plugins/bg-bash` runs
`64 pass, 0 fail`.
