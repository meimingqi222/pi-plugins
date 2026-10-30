# Agent Note: Clear agent stall timer on process exit

Status: implemented

## Problem

A completed child could be labelled stalled while inherited stdio remained open during the bounded drain.

## Decision

Clear the stall interval as soon as exit is observed, while keeping the existing output-drain grace.

## Alternatives considered

Waiting for close conflates a descendant-held pipe with the agent being alive.

## Consequences

Buffered output is still drained, without a post-exit stall verdict.

## Verification

- `plugins/agent-runner/test/executor.test.ts::an exited child cannot be relabelled stalled while inherited stdio drains`

Proved: the pre-fix assertion failed; output saved to `regression-evidence/agent-exit-stall-red.txt`.
