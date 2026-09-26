# Agent Note: Route background bash completions by relevance

Status: implemented

## Problem

Every detached `pi-bg-bash` command sent a visible follow-up containing up to
50 KB of output and started another model turn. A successful command could
finish after the agent had already answered, leaving a second response and a
large transcript block that added nothing to the user's task. The in-memory
job table also disappeared on session reload, so suppressing the push without
another retrieval path would have lost results.

## Decision

Persist background start and terminal metadata as Pi custom entries, while
keeping stdout only in the existing per-job log. A terminal entry renders one
compact TUI status line and does not enter model context. With the default
`notify: "auto"`, success and manual stop do not send model messages; failure
and timeout send only job id, status, exit code, and duration. `always` wakes
for any terminal state and `quiet` never wakes. Simultaneous wake-worthy
completions are batched. The origin and session checks still suppress stale
delivery, and a completion in Pi's post-`agent_end` gap waits for
`agent_settled` before being handed to Pi.

`bg_tasks result` returns bounded terminal metadata and a 40-line / 4 KB
preview; `log` is capped at 2000 lines / 50 KB. `wait` observes one to eight
jobs for at most 30 seconds and supports cancellation. Restoring a session
reconstructs recent terminal records and marks any formerly running record
`interrupted`, without treating its old process as live. The persisted record
does not duplicate the command or stdout. Required job outcomes must be
awaited or inspected before an agent claims success; the tool prompt says so.
The bare-sleep guard blocks without ending the turn, allowing the agent to
call `bg_tasks wait`; terminating the turn would strand a default successful
job, which no longer wakes the agent.

## Alternatives considered

**Always steer while the agent is busy.** Pi cannot guarantee that a message
arriving during final-token streaming is consumed before the original answer;
it can still produce the unwanted extra turn. Only failure or explicit
`always` takes that tradeoff.

**Never wake, including on failure.** A late failure may invalidate the
agent's answer. `quiet` remains available for expected service exits.

**Store full output in session entries.** This would duplicate large, possibly
sensitive logs in the transcript and make session restore expensive.

**Build an agent-graph checkpoint scheduler.** Shell processes need a bounded
wait and explicit notification policy, not a second agent orchestration layer.

## Consequences

Successful fire-and-forget jobs no longer append a late model result. A
task-critical success must be queried or explicitly subscribed to. A late
failure may still cause a short follow-up turn by design. Session records
outlive the in-memory registry, while log retention remains separate: an old
record may have no readable output. The old `bg_bash_result` renderer remains
registered so messages saved by previous versions remain readable.

## Verification

- `plugins/bg-bash/test/plugin.test.ts::a successful background job does not wake the agent after it has settled`
- `plugins/bg-bash/test/plugin.test.ts::default failure wakes with metadata while full output stays queryable`
- `plugins/bg-bash/test/plugin.test.ts::restored terminal metadata stays queryable and missing logs are explicit`
- `plugins/bg-bash/test/plugin.test.ts::a bare sleep while a job runs is blocked without ending the turn`
- `plugins/goal/test/background-combination.test.ts`

Proved: before the change, `bun test plugins/bg-bash/test/plugin.test.ts -t 'a successful background job does not wake the agent after it has settled'` failed with `Expected length: 0, Received length: 1`. After routing by policy, that test and the bg-bash and goal combination suites pass.
