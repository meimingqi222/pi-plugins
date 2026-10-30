# Agent Note: Bound background command log buffering

Status: implemented

## Problem

A slow log sink allowed both child output pipes to enqueue without respecting stream backpressure.

## Decision

Pause both output streams while the shared log sink is saturated, resume on drain or close, and defer quiet-grace while paused.

## Alternatives considered

Unbounded writes can consume memory; dropping output loses the user log.

## Consequences

The child is backpressured by disk throughput, and the existing hard post-exit drain deadline remains.

## Verification

- `plugins/bg-bash/test/run.test.ts::slow logging backpressures both output pipes without dropping data`

Proved: the pre-fix assertion failed; output saved to `regression-evidence/bg-log-backpressure-red.txt`.
