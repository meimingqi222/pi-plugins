# Agent Note: Keep workflow settlement in its launching session

Status: implemented

## Problem

A background workflow captured the extension API but no session identity. Its completion could be sent after a session or history-branch switch. Harness failures produced a status message without requesting a turn, and a delivery exception was swallowed by the registry.

## Decision

Record the launching session ID and a session generation for each run. Stop live runs when leaving a session or branch, and suppress late delivery outside the origin. A failed run with no result requests a follow-up turn. If delivery itself throws, report the failure through the originating UI notification.

## Alternatives considered

**Allow runs to follow the active session.** Their results and goal spend would then belong to different conversations.

**Persist a cross-session inbox.** That would add a new delivery system for runs that are meant to belong to one session.

## Consequences

Switching away cancels outstanding workflow work. Journals remain available for diagnosis or an explicit new run. Failure delivery is visible; a UI notification failure still falls back to stderr.

## Verification

- `plugins/workflow/test/plugin-wiring.test.ts`
- `plugins/workflow/test/plugin-wiring.test.ts::a run cannot deliver into a later session`
- `plugins/workflow/test/plugin-wiring.test.ts::leaving a session stops its workflow even when the session id stays the same`
- `plugins/workflow/test/plugin-wiring.test.ts::a failed background run wakes the caller with its failure`
- `plugins/workflow/test/plugin-wiring.test.ts::delivery failure is visible instead of silently swallowed`

Proved: the session test delivered one stale message before the origin guard and none after. Temporarily removing the failure follow-up options made the bound failure test red; restoring them made it green.
