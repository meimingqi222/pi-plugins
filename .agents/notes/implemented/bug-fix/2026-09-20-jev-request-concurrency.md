# Agent Note: Bound Jev request concurrency

Status: implemented

## Problem

`compact()` launched every state window concurrently and also launched every
question batch inside each window concurrently. A long session could therefore
send dozens of large requests at once, exceed Jev's token-per-second limit, and
make synchronized 429 retries fall back to Pi even though the work was valid.

## Decision

All window/batch requests are flattened into one queue and run through a shared
worker pool. The default limit is four concurrent requests and
`JEV_COMPACT_MAX_CONCURRENCY` can tune it; resolved values are floored to one.

## Alternatives considered

**Process every request sequentially.** This avoids rate spikes but adds
unnecessary latency for the common multi-window case.

**Limit each window independently.** Multiple windows would still multiply the
effective concurrency and recreate the original burst.

## Consequences

Very large sessions can take longer because requests wait for a worker. The
bounded queue makes load predictable across the whole compaction and reduces
rate-limit retries without changing question batching or decisions.

## Verification

- `plugins/jev-compact/test/engine.test.ts::jev_request_concurrency_limit`

Proved: ran the delayed-asker test against the nested `Promise.all` implementation;
peak concurrency was 41 instead of 2, then the test passed with the shared pool.
