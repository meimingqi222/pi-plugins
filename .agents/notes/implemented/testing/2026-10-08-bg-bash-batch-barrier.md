# Agent Note: Synchronize shell settlement in the idle batching regression

Status: implemented

## Problem

The idle batching test launched two real Windows shells sequentially and assumed both would exit within the 25ms batching window. Process startup exceeded that window, so the first correct notification arrived before the second command finished. The missing second id assertion failed even though notification routing behaved as intended.

## Decision

Both shell commands wait on a test-owned file barrier before exiting. The test releases the barrier after both tools have returned their background handles, then requires one short notification containing both ids. Keep production batching, real shell execution, output exclusion assertions and session teardown unchanged.

## Alternatives considered

Increasing the production delay would change user behavior to accommodate test setup. Accepting separate notifications would remove the batching assertion. Replacing shells with mocks would lose process-level coverage.

## Consequences

Shell startup is separated from completion timing. The barrier lives in the test's temporary log directory and is cleaned up by the existing teardown. The test still requires the actual completion router to combine both outcomes.

## Verification

- `plugins/bg-bash/test/plugin.test.ts::explicit always batches simultaneous successes into one short notification`

Proved: The original full suite failed at the assertion requiring bg002 in the first notification, which contained only bg001. Saved the natural failure to `regression-evidence/bg-bash-batch-red.txt`. With the barrier, the same focused test passes.
