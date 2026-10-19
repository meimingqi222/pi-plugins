# Agent Note: Stop launching Jev jobs after one fails

Status: implemented

## Problem

`mapWithConcurrency` used `Promise.all`, which rejects on the first failure
but does not stop the sibling workers. Each worker's `while` loop kept pulling
items and issuing requests, so a transient failure that exhausted retries was
followed by many more uploads of a full conversation state to TypeSafe.
Measured with 40 calls and one immediate failure: `compact()` rejected after
19 requests had already been sent, 15 of them started after the failure was
known.

## Decision

Add a shared `failed` flag. A worker sets it in its catch and rethrows; every
worker checks it before pulling the next item. In-flight requests are not
cancelled — the asker has no cancellation contract — but no new request
starts after a failure.

## Alternatives considered

**Use `Promise.allSettled` and reject after all complete.** Still runs every
job, which is the cost this fixes.

**Share an `AbortController` and cancel in-flight requests.** The asker's
`AskOptions.signal` is optional and a retry loop may already own it; aborting
it from a sibling failure would also abort the retry path and changes the
error the caller sees. Limiting new work is the smaller, safer change.

## Consequences

A failed compaction sends at most the requests that had already started
(equal to the concurrency limit). The rejection and its error are unchanged,
so pi still falls back to its own summary.

## Verification

- `plugins/jev-compact/test/engine.test.ts` — "a failed job stops launching
  further requests" uses `transcript(120)`, four concurrent requests, and
  `failOnRequest: 1`, then asserts at most four `ask` calls.

Proved: with `plugins/jev-compact/src/jev/compact.ts` restored, the test fails with the
old behaviour (all 19 jobs were sent in the measured probe).
