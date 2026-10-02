# Agent Note: Invalid helper specs retain runnable model resolution

Status: implemented

## Problem

An unknown or unauthenticated explicit helper model bypassed physical resolution
and returned the virtual session selection, making goal verification fail even
when a runnable physical answer was available. Malformed specs had the same gap.

## Decision

All invalid-spec branches invoke the default resolver without a spec, preserving
its model, source and warnings. The diagnostic names the bad setting and the
actual fallback model.

## Alternatives considered

Throwing would make a typo prevent verification. Duplicating physical resolution
in each branch would let the fallback rules drift again.

## Consequences

Unknown, malformed and unauthenticated specs share the normal fallback policy.
Explicit valid specs still take precedence.

## Verification

- `plugins/run-core/test/helper-model-fallback.test.ts`
- `plugins/run-core/test/helper-model-fallback.test.ts::invalid helper specs fall back to the physical answer of a virtual selection`

Proved: before the fix the test received router/auto instead of openai/physical;
after the fix all three invalid-spec cases pass.
