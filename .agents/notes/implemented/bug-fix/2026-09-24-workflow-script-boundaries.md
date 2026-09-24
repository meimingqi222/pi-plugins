# Agent Note: workflow script budget and JSON boundaries

Status: implemented

## Problem

`pipeline()` previewed `items.length` as agent calls, even when stages used no
agents or called several per item. Pure data pipelines failed under a small
agent budget, while multi-stage pipelines could be partially admitted despite
the promise of a whole-panel preview. Separately, the worker could return a
BigInt or Map via structured clone and mark the run completed; JSON rendering
then threw, and settlement delivery could silently lose the result.

## Decision

Only actual `agent()` calls are admitted in a pipeline. Its arbitrary stages
have no knowable call count ahead of execution. Keep `parallel()`'s preview for
one-agent-per-task panels, and document its task-count assumption honestly.
At the host completion boundary, reject non-JSON result or meta before marking
the run completed; accepted values are round-tripped into plain JSON.

## Alternatives considered

Multiplying items by stages still mistakes arbitrary JavaScript functions for
agent calls. Reserving that number would reject even more valid pipelines.
Coercing BigInt to string or Map to an empty object would silently alter the
script's return value; validating only in the renderer would still allow an
invalid completed run into the result and journal paths.

## Consequences

Pure pipelines run without agent budget. A pipeline exceeding the limit can
process a prefix and return null for refused items, while every actual agent
call remains bounded. Non-JSON script results now settle as failed with a
visible error instead of completed with an undeliverable payload.

## Verification

- `plugins/workflow/test/host.test.ts` covers both script-host boundaries.
- `plugins/workflow/test/host.test.ts::a pipeline with no agents does not preview or consume agent budget`
- `plugins/workflow/test/host.test.ts::pipeline admits actual agent calls rather than previewing its item count`
- `plugins/workflow/test/host.test.ts::non-JSON result and meta fail before the run is marked complete`
- `plugins/workflow/test/plugin-wiring.test.ts::a non-JSON script result delivers a failed run rather than disappearing`

Proved: before the fixes, the two pipeline tests failed (`Expected: true,
Received: false`) and the JSON test failed (`Expected: false, Received: true`);
all three pass after the changes.
