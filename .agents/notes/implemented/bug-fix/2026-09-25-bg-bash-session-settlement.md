# Agent Note: Keep bg-bash settlement in its launching session

Status: implemented

## Problem

A background bash job captured the extension API and the tool-call context, but no session identity. Its completion could be delivered after a session or history-branch switch — the same stale-delivery gap `2026-09-24-workflow-session-settlement.md` closed for workflow runs. `sendFollowUp` and the `pendingFollowUps` queue had no currentness check, and the extension listened only to `session_start` / `session_shutdown`, so `session_before_switch` / `session_before_tree` / `session_before_fork` were transparent: the OS process kept running, queued follow-ups stayed queued, and the finished job was injected into the new branch as if it belonged there.

## Decision

Record the launching session ID and a session generation before waiting for a command to become backgrounded. Leaving a session or switching history branch kills every running job, clears the follow-up queue, and bumps the generation so any late completion is dropped. Delivery checks `isCurrent()` both when a job finishes and when a queued follow-up is flushed on `agent_end`. A late callback also checks the job object's identity: `session_start` resets ids to `bg001`, so the old `bg001` must not settle a new one. Jobs are killed rather than left running detached: a background process is owned by the conversation that launched it, and the next branch must not inherit it. Origin reads and the idle probe are fail-closed: a context that cannot answer is treated as stale, and the completion is dropped rather than thrown into the detached callback.

## Alternatives considered

**Keep jobs alive across a branch switch and only suppress delivery.** The process would still write logs, consume CPU, and show up in `bg_tasks` belonging to a context the user has left — conversation-external state that the next turn cannot explain.

**Inherit jobs and their follow-ups into the new session.** The result would belong to a different conversation than the command that started it.

**Only check the session ID, without a generation.** A branch switch can keep the same session ID; workflow already needed the generation for that case.

## Consequences

Switching away cancels outstanding background work. The log file remains for diagnosis. A completion that races the leave is suppressed rather than replayed. The origin snapshot is a small closure per job; `Runtime` grew `captureOrigin` so the tool layer can take the snapshot before its first await.

## Verification

- `plugins/bg-bash/test/plugin.test.ts`
- `plugins/bg-bash/test/plugin.test.ts::a background job cannot deliver into a later session`
- `plugins/bg-bash/test/plugin.test.ts::leaving a session kills its background jobs and drops the completion`
- `plugins/bg-bash/test/plugin.test.ts::a follow-up queued for a busy agent is dropped when the session leaves`
- `plugins/bg-bash/test/plugin.test.ts::a completion from a torn-down session manager is dropped, not thrown`
- `plugins/bg-bash/test/plugin.test.ts::a completion is dropped, not thrown, when isIdle is also torn down`
- `plugins/bg-bash/test/plugin.test.ts::an old job cannot settle a reused id after session_start`
- `plugins/bg-bash/test/plugin.test.ts::auto-backgrounding keeps the session where the command started`

Proved: stubbed `captureOrigin` to always return true and removed the `session_before_*` leave hooks → the three bound tests failed as expected (stale message delivered, job left `running`, queued follow-up flushed after leave), then restored the fix and all three passed again. With the origin reads unguarded, the torn-down-context test failed with `error: session manager unavailable` escaping the completion chain; wrapping both reads made it pass — a completion whose origin cannot be read is suppressed rather than thrown. With only the idle probe unguarded, the isIdle test failed on `error: context torn down` escaping `sendFollowUp`; the fail-closed probe made it pass with no message and no escaped rejection.

Follow-up: before the job-identity check, the reused-id test failed because the new `bg001` became `killed` when the old job settled. Moving origin capture before the first await and checking the object identity made both new tests pass.
