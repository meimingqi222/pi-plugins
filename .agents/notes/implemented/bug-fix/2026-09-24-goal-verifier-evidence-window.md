# Agent Note: Retain early and recent goal evidence

Status: implemented

## Problem

The verifier included only the newest whole session entries up to its context cap. In a long goal, an early implementation or test result could disappear, leading the verifier to request work that had already been done.

## Decision

Reserve up to a quarter of the bounded transcript for earliest whole entries and keep the newest whole entries in the remainder. Elide the middle when needed, keep chronological order, and continue to mark truncated evidence. A newest entry larger than the entire window retains the existing clipped-tail fallback.

## Alternatives considered

**Increase the transcript cap.** Provider context limits still require a bound, and larger payloads cost more.

**Give the verifier tools.** That would change its isolated judgment contract and require a separate authority model.

## Consequences

Early and recent observations can both reach the verifier without increasing the cap. Evidence in the elided middle or an oversized early entry may still be absent, so a verdict remains a bounded judgment.

## Verification

- `plugins/goal/test/verifier.test.ts`
- `plugins/goal/test/verifier.test.ts::bounded transcript preserves early and recent evidence in a long goal`
- `plugins/goal/test/verifier.test.ts::bounded transcript keeps whole entries from both ends`

Proved: the long-goal test failed because `evidence-0` was absent under the prior newest-only policy, then passed with the two-ended window.
