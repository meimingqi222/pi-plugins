# Agent Note: Reviewer decisions require complete calls and current context

Status: implemented

## Problem

A reviewer could approve only the first 4,000 characters of a tool call and then release the complete call. Its cache also reused decisions after the user's request or static analysis changed.

## Decision

Calls exceeding the review limit fall back to approval. Cache keys include the entire user request, tool name, input and static analysis.

## Alternatives considered

Truncating calls keeps reviews cheap but lets unreviewed effects run. Disabling caching would also avoid stale decisions but loses useful reuse for identical evidence.

## Consequences

Long calls need human approval or are denied headlessly. Changed requests or analysis consume another review; identical evidence can still use the cache.

## Verification

- `plugins/permissions/test/reviewer.test.ts::oversized calls are never approved from a truncated review`
- `plugins/permissions/test/reviewer.test.ts::a changed user request does not reuse a previous verdict`

Proved: the pre-fix assertions failed; output saved to `regression-evidence/reviewer-boundaries-red.txt`.
