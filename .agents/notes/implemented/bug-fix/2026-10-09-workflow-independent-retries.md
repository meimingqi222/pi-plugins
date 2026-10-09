# Agent Note: Separate transport and schema retry limits

Status: implemented

## Problem

retries: 1 capped the outer loop and disabled transport recovery.

## Decision

Track schema attempts and transport failures independently, admitting and billing every invocation.

## Alternatives considered

Increasing one shared counter changes schema limits; retrying write-capable roles risks duplicate effects.

## Consequences

Read-only transport recovery remains bounded independently of schema repair.

## Verification

- Test file: `plugins/workflow/test/security-budget.test.ts`

- `plugins/workflow/test/security-budget.test.ts::schema attempt limit does not consume a read-only transport retry`

Proved: The test originally failed with fetch failed after one call; afterward call two succeeds under the same schema limit.
