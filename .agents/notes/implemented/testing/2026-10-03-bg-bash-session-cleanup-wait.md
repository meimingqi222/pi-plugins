# Agent Note: Wait for asynchronous session process cleanup

Status: implemented

## Problem

The session cleanup regression waited a fixed 400ms before checking that jobs
stopped. Windows taskkill runs asynchronously, and measured settlement was near
that limit even when idle. Under full-suite load the assertion ran before the
process exited, intermittently rejecting correct cleanup.

## Decision

Poll the non-consuming status surface until a terminal state, with a 3s bound
shorter than the command's 5s sleep. Require killed, no leftover output and no
completion message. Keep the production cleanup unchanged.

## Alternatives considered

Increasing the fixed sleep wastes time and retains the race. Using bg_tasks wait
or result would consume pending notifications and hide a completion-routing bug.
Accepting any terminal state could pass if the process simply completed normally.

## Consequences

The test tolerates asynchronous OS termination while still failing if cleanup
does not kill the job. Status and output reads do not consume notifications.

## Verification

- `plugins/bg-bash/test/plugin.test.ts`
- `plugins/bg-bash/test/plugin.test.ts::leaving a session kills its background jobs and drops the completion`

Proved: the original 400ms assertion failed during full-suite runs with the job
still running. With bounded polling the test passes. Temporarily disabled
registry.killAll in leaveSession: the revised test failed after 3s, receiving
running instead of killed; restored the call and verified it passes again.
