# Agent Note: Preserve orphan tool results

Status: implemented

## Problem

All toolResult rows were skipped even when their call left the compaction window.

## Decision

Collect call IDs, fold paired results once, and preserve orphan results as provenance-tagged text.

## Alternatives considered

Fabricating calls alters history; dropping orphans loses evidence before any decision.

## Consequences

Orphan evidence survives without fabricated calls; paired results remain deduplicated.

## Verification

- Test file: `plugins/jev-compact/test/pi-adapter.test.ts`

- `plugins/jev-compact/test/pi-adapter.test.ts::an orphan tool result survives projection without a fabricated call`

Proved: Projection originally contained no evidence and failed; afterward evidence survives with zero tool calls.
