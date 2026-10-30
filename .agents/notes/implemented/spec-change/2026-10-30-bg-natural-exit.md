# Agent Note: Preserve background children after a natural shell exit

Status: implemented

## Problem

Unconditional process-group cleanup after a successful shell exit killed intentionally detached shell background commands.

## Decision

Natural shell exit does not signal descendants. Explicit stop, abort, and timeout still terminate the process group. The terminal job no longer manages a surviving background child; users must manage it separately.

## Alternatives considered

Always killing descendants prevented abandoned processes, but broke ordinary redirected `cmd &` commands. Continuing to track arbitrary descendants after shell exit would require a different portable job model.

## Consequences

A redirected background service can outlive the shell. Unredirected descendants may still lose their pipes after the bounded drain; the plugin no longer owns surviving processes after settlement.

## Verification

`plugins/bg-bash/test/run.test.ts::natural shell exit preserves redirected background descendants` failed before this decision; output is in `regression-evidence/bg-natural-exit-red.txt`.
