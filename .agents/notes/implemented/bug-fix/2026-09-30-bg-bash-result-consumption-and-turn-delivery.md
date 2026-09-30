# Agent Note: Deliver unread bash completions at parent turn boundaries

Status: implemented

## Problem

Background bash already used Pi's native steering queue during active runs,
but a 25 ms arrival-time batching timer submitted notices before the current
tool batch finished. A result or wait query could return the same terminal
outcome without consuming its pending notice, causing redundant input or a
post-summary follow-up. The old settled fallback captured an anonymous batch
which queries could not remove. Pending notices were also cleared before a
synchronous send failure, permanently losing the wake-up despite reporting it.

## Decision

Keep a single job-keyed pending map until successful submission or explicit
result consumption. During an active run, flush unread notices at turn_end
with native steer, after all tools have returned. Agent settlement flushes
late results with followUp, including results in the final native-check gap.
An aborted parent turn skips the turn boundary and keeps this fallback.

Idle notices retain their short batching delay. Manual compaction without an
active run retains the idle retry timer rather than starting an agent run.
Synchronous send failures retain pending jobs for the next boundary or idle
retry, with one UI warning per affected job until delivery succeeds. Submitted
means the void sendMessage API returned, not that asynchronous execution has
been transactionally acknowledged.

Result and wait responses acknowledge only terminal jobs whose results were
successfully formatted. A partial or timed-out wait acknowledges its finished
jobs but not jobs still running. Aborted queries and changed registries do not
acknowledge anything. List, status, log, output, kill, and TUI inspection keep
their existing inspection/control contracts and do not consume notifications.
Consumption and submission use separate WeakSets keyed by Job identity;
session leave clears them and the pending map, so recycled ids cannot inherit
acknowledgments. Every submission rechecks its launching session.

Keep notify policy unchanged: auto wakes only for failure/timeout, always for
any completion, and quiet never wakes. Durable terminal records and output
logs remain available whether or not the model consumed a notification.

## Alternatives considered

**Copy subagent revision tracking.** Bash jobs have one terminal outcome,
unlike a live child answering multiple replies. Job identity is sufficient;
introducing result revisions would add state without a supported use case.

**Send every completion at arrival time.** Native steering permits it, but
the current tool batch has not had its full opportunity to consume results.
Boundary submission makes that opportunity deterministic.

**Treat raw output or status inspection as acknowledgment.** These actions
are also used for progress monitoring and do not carry the result contract.
Only result/wait opt into acknowledgment in this change.

**Change the shared settled queue.** Workflow retains its independent policy.
Changing the generic primitive would unnecessarily expand this bug fix.

## Consequences

Required bash results can be read without an extra pending notification
restarting the parent afterward. Unread failures still invalidate a stale
success claim, while ordinary successful jobs remain quiet by default.
Already submitted native inputs cannot be withdrawn. A completion during
final response streaming can still require another response; required jobs
must be awaited before claiming success. No durable record format changes.

## Verification

- `plugins/bg-bash/test/plugin.test.ts::an active agent receives an opted-in completion as a short steer`
- `plugins/bg-bash/test/plugin.test.ts::a terminal result consumes a pending completion before settlement`
- `plugins/bg-bash/test/plugin.test.ts::a terminal wait consumes a pending completion before settlement`
- `plugins/bg-bash/test/plugin.test.ts::a refused boundary submission remains pending for retry`
- `plugins/bg-bash/test/plugin.test.ts::a partial wait consumes only terminal jobs returned in its result`
- `plugins/bg-bash/test/plugin.test.ts::an aborted wait does not consume terminal results included in its response`
- `plugins/bg-bash/test/plugin.test.ts::an idle refusal retries without repeating the UI warning`
- `plugins/bg-bash/test/plugin.test.ts`
- `plugins/bg-bash/test/tasks-tool.test.ts`

Proved: before changing the runtime, running
`bun test plugins/bg-bash/test/plugin.test.ts` produced 39 passes and 10
failures. The active-run test expected zero messages before turn_end and
received one. Result/wait consumption expected no settled follow-up and
received one. Boundary retry expected its first submission attempt at
turn_end and received zero. The inspection and abort regressions also
failed because the old implementation had no turn-end submission handler.
The suite exercises real shell processes with a fake extension API; the
native queue semantics themselves are covered by the subagent Pi-runtime
tests. No network model calls are required.
