# Agent Note: Keep goal usage in workflow progress

Status: implemented

## Problem

The workflow settlement callback falls back to the last progress snapshot if
an unexpected harness failure leaves no result. That snapshot held only
`spentTokens`, which excludes cache reads and writes, so the parent goal would
under-count a partially completed run precisely on the failure path.

## Decision

Progress carries `goalTokens`, the same cache-inclusive current-run sum as the
terminal result. On a resultless settlement the parent uses that figure, never
`spentTokens` with its different unit.

## Alternatives considered

Charging `spentTokens` would mix two token dimensions. Charging zero would
hide all completed child work before the harness failure.

## Consequences

The progress file contains one extra optional number. Workflow's own budget
and displayed `spentTokens` continue to mean input plus output.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — test "live progress keeps cache-inclusive spend for goal settlement".

Proved: temporarily omitted `goalTokens` from the progress snapshot; the bound
test failed with `Expected: true`, `Received: false`. Restored it and the test
passed.
