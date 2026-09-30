# Agent Note: Deliver unread subagent results at safe parent boundaries

Status: implemented

## Problem

A child turn could finish while its parent was busy. The answer was available
through show or wait, but its notification remained in an anonymous private
queue until the parent's entire run settled. Reading the answer did not
consume that queue entry, so the parent could summarize the work and then
receive the same answer in a newly triggered run. A raw-log query could also
show output early, without any structured indication that the canonical
settled answer had already been returned.

The historical 2026-09-26 rationale overstated a genuine final-check race:
it could be read as forbidding all active-run delivery. Pi 0.85.1 supports
native steering and follow-up delivery while running. Its agent loop emits
turn_end after all tool results, then checks steering before the next model
call. The vulnerable window is after its final native-queue check and before
agent_settled, not the entire run. The "already processing" error associated
with bare prompt commands is not a blanket limitation on sendMessage's
native queue modes.

## Decision

The subagent owns a revision-aware result delivery component instead of
sharing the generic settled-only queue. Workflow and bg-bash keep their
existing policies; the generic pi-run-core primitive is unchanged.

- Lane resultRevision advances for each settled child answer and for a new
  terminal outcome. Process exit repeating an already reported outcome keeps
  the revision. An exceptional terminal failure clears the stale turn result.
- Pending results are identified by lane id and revision within the existing
  session-generation guard. Submitted and proactively consumed revisions are
  separate watermarks. Returning a newer answer also supersedes older pending
  revisions; reading an older answer cannot consume a later one.
- While busy, the parent submits unread results at turn_end, after the whole
  tool batch has had the opportunity to read them, using native steer. A result
  arriving after the last turn boundary uses agent_settled as its fallback.
  Idle success and failure results request a follow-up immediately. An aborted parent
  turn skips the turn-end submission and retains the fallback.
- Success and failure results use the native queue and request a follow-up
  when idle. A real runtime regression showed that context-only failure
  messages appended to history did not reach the next active model request;
  failures therefore need the same native delivery path as success. Cancellation
  remains context-only, explicitly setting triggerTurn false. Session leave
  clears both pending results and watermarks; every submission rechecks origin.
- Show and wait returning the canonical answer consume that revision. Log
  queries append the latest canonical settled answer, independently of raw-log
  filtering, truncation, or file availability, then consume its revision.
  Status, events, partial logs, and human-facing UI inspection do not consume
  results. An aborted query cannot acknowledge a result.
- Synchronous send refusal leaves a result pending for another safe boundary.
  A watermark advances only after sendMessage returns. This means submitted
  to Pi, not a transactional guarantee of model execution: Pi's extension API
  returns void and reports asynchronous send failures through its runtime.

The audit follows the installed Pi session sendCustomMessage routing and agent
loop queue checks. Real AgentSession tests use an offline model stream, isolated
credentials/resources, and the actual extension runner, message conversion,
tool execution, native queues, and run lifecycle. They verify that a busy result
reaches the next model request in one agent run, a tool-read result adds no
duplicate input, a failure reaches the next request, and a completion injected
after the final native queue check wakes exactly one settled follow-up.

## Alternatives considered

**Wait for agent_settled for every result.** Safe but unnecessarily late;
without consumption tracking it produces redundant post-summary runs.

**Send immediately whenever a child finishes.** Native modes work during a
run, but blind arrival-time submission retains the final-check race and cannot
withdraw a notification when a query in the current tool batch reads it.

**Use one notified boolean.** Conflates queued, submitted, and consumed states
and loses subsequent reply answers. The reference ZCode TaskOutput claim is
useful, but enqueue-time claiming alone cannot retract already queued notices.

**Treat any log read as final-result consumption.** Progress and truncated raw
JSONL do not establish delivery of a canonical answer. Appending the structured
answer gives the query an explicit, revision-scoped delivery contract.

**Replace the shared delivery queue globally.** Workflow and bg-bash have
different wake and result policies. A subagent-specific component keeps this
change bounded while retaining their existing regression coverage.

## Consequences

Unread results normally reach the parent before its next model call, rather
than after its entire run. Proactive result queries no longer produce a
redundant follow-up while the same notification is still plugin-pending.
Already submitted Pi inputs cannot be retracted. A result arriving during
final-answer streaming cannot retroactively change displayed tokens and may
still require a later response. Required outcomes must be awaited before
claiming completion.

Log answers retain the normal 50 KB model-facing result bound, in addition to
the existing 32 KB raw-preview bound. No new public tool, acknowledgment
parameter, durable format, child transport, or spend-accounting policy is
introduced. The README, historical refactor plan, and superseded portions of
the 2026-09-26 and 2026-09-28 notes describe the corrected boundary contract.

## Verification

- `plugins/subagent/test/result-delivery.test.ts::an unread answer enters the active run at turn_end and is not resent at settlement`
- `plugins/subagent/test/result-delivery.test.ts::a truncated log appends the canonical final answer before consuming it`
- `plugins/subagent/test/result-delivery.test.ts::process exit does not reannounce an already read failed turn`
- `plugins/subagent/test/result-delivery.test.ts`
- `plugins/subagent/test/pi-delivery.test.ts::turn_end steering reaches the next model call within the same run`
- `plugins/subagent/test/pi-delivery.test.ts::a tool-read result creates no duplicate native input or extra run`
- `plugins/subagent/test/pi-delivery.test.ts::an unread failure reaches the next model call within the same run`
- `plugins/subagent/test/pi-delivery.test.ts::a completion after agent_end wakes exactly one settled follow-up`
- `plugins/subagent/test/lane-reply.test.ts`
- `plugins/goal/test/background-combination.test.ts`
- `plugins/goal/test/lifecycle.test.ts`

Proved: before replacing the delivery path, running
`bun test plugins/subagent/test/result-delivery.test.ts` produced 12 failures
and 2 passes. The turn-end test expected 1 submission and received 0; show/wait
consumption expected 0 late submissions and received 1; log lacked the
canonical answer. After implementing revision-aware delivery those tests
passed. The additional failed-turn/process-exit regression failed with
Expected length 0, Received length 1 before terminal revision reuse, then
passed. Removing stale-result clearing made the exceptional terminal-failure
test return "first answer" instead of "new failure"; restoring it made the
test pass. The real runtime failure-delivery test initially lacked child
evidence in the second model request with triggerTurn false; native steering
made it pass. All four real Pi native-delivery tests pass without network
requests.
