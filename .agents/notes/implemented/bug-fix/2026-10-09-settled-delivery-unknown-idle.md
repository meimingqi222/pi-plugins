# Agent Note: Defer delivery on an unknown idle state

Status: implemented

## Problem

Idle-probe errors inherited true and sent immediately.

## Decision

Default to non-idle and defer to agent_settled, preserving origin rechecks in send callbacks.

## Alternatives considered

Immediate sends bypass sequencing; dropping loses valid results.

## Consequences

Valid origins receive queued results at settlement; stale origins may discard them.

## Verification

- Test file: `plugins/run-core/test/security-accounting.test.ts`

- `plugins/run-core/test/security-accounting.test.ts::a failed idle probe defers delivery until the settled event`

Proved: Before the fix send count was 1 before settlement; afterward it is 0 before and 1 after.
