# Agent Note: Distinguish unknown usage from measured zero

Status: implemented

## Problem

Missing usage became zero, bypassing token-bounded goal enforcement.

## Decision

Return null for missing/malformed usage, share the isolated-call reader, propagate null through spend leases and stop bounded goals.

## Alternatives considered

Guessing zero is fail-open; estimated tokens do not establish billed usage. Unbounded goals can continue.

## Consequences

The reader and spend lease now accept nullable usage. Measured zero is valid; bounded unknown usage becomes budget_limited.

## Verification

- Test file: `plugins/run-core/test/security-accounting.test.ts`

- `plugins/run-core/test/security-accounting.test.ts::unknown usage is distinct from a measured zero-token response`

Proved: The reader test failed before the change. Disabling the goal guard made both goal unknown-usage tests fail; restoration makes them pass.
