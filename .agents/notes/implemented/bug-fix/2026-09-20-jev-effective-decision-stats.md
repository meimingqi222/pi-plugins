# Agent Note: Report effective Jev decisions

Status: implemented

## Problem

Jev can request deletion or truncation of an output too short to replace with a
smaller marker. `applyDecisions()` correctly kept those outputs, but the returned
decisions and stats still reported them as dropped. User notices and persisted
details therefore disagreed with the serialized summary.

## Decision

Before applying decisions, the engine converts any no-op deletion into an
explicit `keep` with reason `not_smaller`. Stats count these effective actions,
and the notice describes `drop_call` accurately as discarding output while
retaining a callable trace.

## Alternatives considered

**Recompute only the aggregate counters after serialization.** This fixes the
notice but leaves persisted per-call decisions contradicting the output.

**Always write the discard marker.** That makes short outputs larger and violates
the compactor's non-growth invariant.

## Consequences

The decision reason union gains `not_smaller`, so consumers can distinguish a Jev
keep verdict from a size-based keep. Probabilities remain intact, while actions,
stats, details, and rendered output now agree.

## Verification

- `plugins/jev-compact/test/engine.test.ts::jev_effective_drop_call_decision`
- `plugins/jev-compact/test/engine.test.ts::jev_effective_drop_result_decision`

Proved: ran both tests before effective-decision reconciliation; they received
`drop_call` and `drop_result` despite unchanged output, then passed after the fix.
