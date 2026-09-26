# Agent Note: Invalidate background subagents on history navigation

Status: implemented

## Problem

The subagent origin guard checked session ID and a generation advanced only on
shutdown. Tree navigation preserves the session ID, so an old branch's result
could be injected into the selected branch and trigger a new model turn.

## Decision

Invalidate the generation and abort background tasks on session_before_tree,
session_before_fork and session_before_switch as well as shutdown. Advance the
generation before aborting so even a synchronous or late completion is stale.
Existing goal-spend settlement still runs before delivery is suppressed.

## Alternatives considered

Checking only session ID misses branch navigation. Checking the current leaf
on every delivery would also reject ordinary conversation progress. Aborting
without invalidating the generation allows an uncooperative executor's late result.

## Consequences

Background work does not migrate to another history branch. As with the other
background plugins, initiating navigation cancels work even if another handler
later cancels navigation. Users can launch a new task in the desired branch.

## Verification

- `plugins/subagent/test/plugin.test.ts`
- `plugins/subagent/test/plugin.test.ts::a background task is cancelled on tree navigation and late results cannot wake the new branch`

Proved: before the fix the new test failed with aborted false instead of true.
After the fix it passes, then resolves an executor that ignored cancellation
and verifies that no result message is delivered to the unchanged session ID.
