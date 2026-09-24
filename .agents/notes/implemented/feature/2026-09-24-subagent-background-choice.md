# Agent Note: Let the caller choose background subagent execution

Status: implemented

## Problem

The original `subagent` tool always waited for its child. An independent
investigation prevented the parent from continuing other work, even though Pi's
workflow already demonstrated that child results can arrive after a tool call.

## Decision

Add an optional `background` boolean to the same single-task tool. False or
omitted preserves the foreground answer. True returns a task ID immediately;
`subagent_tasks` lists, shows and cancels tasks. A completed answer is delivered
as a follow-up message. Failed and cancelled tasks are displayed without
automatically starting another turn. The in-memory registry caps active tasks
at four and keeps the 20 most recent settled results. Session shutdown cancels
active tasks and prevents late delivery to a different session. The goal spend
lease stays open until the child settles.

## Alternatives considered

- Reusing workflow would require a script and its journal for one task.
- Making every subagent asynchronous would make dependent work need an extra
  status call.
- Persisting child sessions or task handles would add a resume contract beyond
  this single-task capability.

## Consequences

The caller can overlap independent work while preserving the direct answer path
for dependent work. Background task history is session-local and does not
survive a Pi restart. Goal budget enforcement remains based on reported usage;
already running children can exceed the budget before they settle.

## Verification

- `plugins/subagent/test/plugin.test.ts` — test "background returns immediately, then delivers the answer and charges goal usage".
- `plugins/subagent/test/plugin.test.ts` — test "a background task can be cancelled and cannot notify a switched session".

Proved: temporarily bypassed background dispatch; the test timed out after
5000ms because the tool waited for its executor instead of returning a task ID.
Restored dispatch; both bound tests passed.
