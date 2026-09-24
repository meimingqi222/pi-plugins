# Agent Note: Do not verify an interrupted work run after background settlement

Status: implemented

## Problem

A goal work run could finish while its workflow remained active. The goal held
that run for later verification. Pausing and resuming kept the same goal id, so
the workflow's late settlement verified work from before the pause as if it were
the resumed attempt.

## Decision

Invalidating a work turn clears its deferred verification. The delegation lease
remains live: its eventual usage still belongs to the goal and can exhaust its
budget. A later work run has to produce its own candidate for verification.

## Alternatives considered

Dropping the lease on pause would hide already incurred cost. Letting the old
turn verify after resume would bypass the resumed attempt's work boundary.

## Consequences

Pause, replace, input interruption and session transitions cannot resurrect a
deferred verification. Costs still settle against the same goal and session.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — test "pause and resume do not verify a stale settled run after its workflow finishes".

Proved: before clearing `deferredRun` in `invalidate()`, the bound test failed
with `Expected: 0`, `Received: 1` verifier calls; after the fix it passed.
