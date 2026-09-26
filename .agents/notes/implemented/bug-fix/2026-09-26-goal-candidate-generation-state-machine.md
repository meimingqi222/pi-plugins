# Agent Note: Judge goal candidates by generation and settled transcript

Status: implemented

## Problem

`pi-goal` represented one completion claim with independent `candidatePending`,
`candidateReady`, and `candidateRun` values. Pi's `agent_end` is only a low-level
run boundary: retries and plugin follow-ups can run before `agent_settled`.
The flags could describe contradictory states, and a queued follow-up arriving
while an isolated verifier awaited its model could let an obsolete verdict
complete the goal before the new transcript was available.

## Decision

Use a monotonic `candidateGeneration` and one `candidateState` phase:
`reported`, `ready`, `verifying`, or `interrupted`. A report records its work-run
index. A final assistant `stop` changes it to `ready`. If the goal itself blocks
post-candidate tool calls with `terminate`, Pi ends on the tool-call assistant
message (`stopReason: "toolUse"`) without another model response; that
specifically observed termination also changes the claim to `ready`. Other
non-clean endings remain interrupted. A stable idle `agent_settled` may start
verification. The verifier captures goal id, candidate
generation, and work-run epoch, then rejects a result if any changed. A queued
message detected before launch or before verdict commit defers judgment until
the next settled transcript. An interruption requires a new report, advancing
the generation. Schema-1 snapshots using the old flags are converted on read;
restored in-flight claims become interrupted, and judged claims stay judged.
The `agent_settled` handler schedules settlement on the next event-loop turn
instead of awaiting the verifier while Pi is still dispatching handlers. This
lets later synchronous extensions deliver follow-ups before the idle and queue
checks. Pi does not expose a post-dispatch hook for arbitrarily slow asynchronous
handlers; such handlers must use their own reliable delivery boundary.
The work-run cap is also checked at `agent_start`, so a sequence of plugin
continuations cannot bypass it by preventing `agent_settled`.

## Alternatives considered

**Add another readiness flag.** More combinations would make the event-order
problem harder to reason about and would not identify stale verifier results.

**Verify at `agent_end`.** Pi may still retry or deliver plugin follow-ups, so
the evidence would omit subsequent messages.

**Await verification inside `agent_settled`.** Pi dispatches extension handlers
serially. A fast verifier could finish before a later handler delivered a
follow-up, even though both observed the same settled event.

**Trust cancellation alone.** A model call can complete after abort, and a
follow-up can be queued before its new run starts. The generation, run epoch,
and queue checks are needed at the verdict boundary.

**Require `stopReason: "stop"` even after goal-enforced tool termination.** Pi
ends a terminating tool batch on the original `toolUse` response and does not
ask for the final text response suggested by the tool-block reason. Treating
that as an interruption would discard the candidate and schedule a needless
re-report; instead, track whether goal blocked a tool and accept `toolUse` only
when that guard caused the termination.

## Consequences

New snapshots write one candidate phase and a generation, not the old flags.
Old snapshots remain readable. A claim restored from an earlier session must
be re-reported before verification. A verdict paid for while another plugin
queues a message is billed but discarded; the same generation is judged after
the follow-up settles. The separate post-candidate turn limit remains a safety
bound when Pi cannot terminate a mixed tool batch. When goal's own block ends
a candidate run with `toolUse`, the same candidate is verified after settlement
rather than being marked interrupted and re-reported.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::a candidate in a run that errors is flagged unjudged`
- `plugins/goal/test/lifecycle.test.ts::a rejected candidate clears pending`
- `plugins/goal/test/lifecycle.test.ts::a new candidate after a rejection`
- `plugins/goal/test/lifecycle.test.ts::candidate snapshot migration keeps rejected claims judged`
- `plugins/goal/test/lifecycle.test.ts::an unknown candidate phase pauses without losing the saved goal`
- `plugins/goal/test/lifecycle.test.ts::run cap pauses across plugin continuations even without agent_settled`
- `plugins/goal/test/lifecycle.test.ts::a queued follow-up invalidates a verdict before its run starts`
- `plugins/goal/test/lifecycle.test.ts::a candidate is not ready when the run has no clean final assistant response`
- `plugins/goal/test/lifecycle.test.ts::another settled handler can start a follow-up before verification begins`
- `plugins/goal/test/lifecycle.test.ts::a goal-terminated tool batch leaves its candidate ready for verification`

Proved: the first three tests failed before the phase conversion because
`candidateState` and `candidateGeneration` were absent. The snapshot test first
resurrected a judged claim as `interrupted`. The queued-follow-up test first
observed `complete` instead of `active`. The missing-final-response test first
cleared the claim by verifying it. Each passed after its corresponding fix.
The unknown-phase test first lost the entire restored goal, then passed after
the phase was coerced to interrupted and the goal paused.
The no-settlement run-cap test first remained `active` after the third run
started, then paused with the entrance check.
The later-handler test first observed one verifier call before the follow-up,
then zero after settlement was deferred until all handlers could run. The
goal-terminated-tool-batch regression first failed with `Expected: 1, Received:
0` verifier calls before the termination-aware phase transition, then passed
with the goal-blocked `toolUse` ending accepted as ready.
