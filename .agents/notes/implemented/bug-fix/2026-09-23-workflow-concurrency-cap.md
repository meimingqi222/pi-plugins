# Agent Note: Bound workflow child concurrency to four

Status: implemented

## Problem

`runWorkflow` defaulted `maxConcurrency` to 8 and the `workflow` tool schema
allowed up to 32. A `parallel()` panel could therefore open eight (or more)
child sessions at once. Many providers reject that burst with a hard error
rather than a retryable 429, so a normal fan-out failed for reasons unrelated
to the script.

## Decision

Default and hard cap are both four. The orchestrator clamps
`maxConcurrency` with `Math.min(4, Math.max(1, …))`, and the tool schema
rejects values above 4 at the surface. Values of 1–4 behave as before.

## Alternatives considered

**Only lower the default to 4, leave the schema maximum at 32.** The model
(or a saved workflow) could still request a wider panel and re-trigger the
provider errors the default was meant to avoid.

**Make the cap configurable per provider.** No per-provider signal exists at
this layer; a single conservative bound covers the common case.

## Consequences

Wider fan-out is sequentialized rather than refused: scripts with many
`parallel()` tasks still all run, just four at a time. Callers that asked for
more than four silently get four.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — `the default panel is capped at four concurrent agents`,
  `maxConcurrency above four is clamped to four`, and the existing
  `a parallel panel is bounded by maxConcurrency but all tasks run`.

Proved: ran the new tests against the previous default of 8 / clamp-off —
peak concurrency reached 8 when `maxConcurrency` was omitted or set to 16;
both fail without the clamp, pass with it.
