# Agent Note: Isolate tests from scheduler switches

Status: implemented

## Problem

Inherited child scheduler flags prevented test plugin registration.

## Decision

Clear three switches only through Bun test preloads at root and scheduler packages. Preserve production agentChildEnv.

## Alternatives considered

Removing flags from production permits recursive scheduling; cleaning only pre-push misses direct test runs.

## Consequences

Direct and workspace tests work inside child sessions; explicit flag unit tests retain their own inputs.

## Verification

- Test file: `plugins/goal/test/scheduler-env.test.ts`

- `plugins/goal/test/scheduler-env.test.ts::test harness clears inherited scheduler switches`

Proved: With all three flags set the test failed before preload. Baseline was 597 pass and goal-disabled had 99 fail. The preload fixes inherited-flag registration.
