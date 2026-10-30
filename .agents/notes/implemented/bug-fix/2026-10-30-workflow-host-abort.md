# Agent Note: Propagate host termination to agent calls

Status: implemented

## Problem

The host timeout signal was discarded by the orchestrator, and worker failure left in-flight agents running.

## Decision

Use the host signal for agent invocation and admission, and abort abandoned calls when a worker fails.

## Alternatives considered

Only forwarding the external run signal misses a host timeout. Aborting on normal completion would change the existing bounded-drain contract.

## Consequences

Host timeouts and failures stop in-flight work; successful scripts retain bounded draining.

## Verification

- `plugins/workflow/test/orchestrator.test.ts::host timeout aborts an in-flight agent before its own deadline` and `plugins/workflow/test/orchestrator.test.ts::a failed workflow aborts its abandoned in-flight agent`

Proved: the pre-fix assertion failed; output saved to `regression-evidence/workflow-host-abort-red.txt` and `regression-evidence/workflow-worker-abort-red.txt`.
