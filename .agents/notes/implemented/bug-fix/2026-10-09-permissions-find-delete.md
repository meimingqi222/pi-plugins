# Agent Note: Check find deletion boundaries

Status: implemented

## Problem

find -delete was grey even at filesystem or home roots.

## Decision

Apply recursive-deletion boundaries to search roots, including implicit cwd and unknown roots.

## Alternatives considered

Allowing every find ignores mutation; denying every find blocks read-only search.

## Consequences

Root/home deletion denies, outside or unknown deletion asks. Predicates are treated conservatively.

## Verification

- Test file: `plugins/permissions/test/security-boundaries.test.ts`

- `plugins/permissions/test/security-boundaries.test.ts::find deletion checks filesystem boundaries and outside targets`

Proved: Before the fix find / -delete was allowed and the test failed; afterward the boundary cases pass.
