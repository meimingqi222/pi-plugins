# Agent Note: Negotiate one versioned redaction service contract

Status: implemented

## Problem

Consumers accepted inconsistent shapes, notably goal accepting malformed v2 announcements without live enablement.

## Decision

Share a small contract library across the publisher and consumers; v1 remains compatible and v2 requires isEnabled. The publisher additionally validates its diagnostic pattern count.

## Alternatives considered

Duplicated predicates drift, while depending on the redactor extension itself would remove independent installation.

## Consequences

Consumers install the lightweight contract library and use identical compatibility checks.

## Verification

- `plugins/goal/test/verifier.test.ts::redaction bridge rejects v2 services without live enablement` and `plugins/redact-contract/test/compatibility.test.ts::all consumers negotiate the same v1 and v2 service shapes`

Proved: the pre-fix assertion failed; output saved to `regression-evidence/redact-contract-red.txt`.
