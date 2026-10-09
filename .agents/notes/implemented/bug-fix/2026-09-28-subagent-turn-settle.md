# Agent Note: Deliver a background lane's answer at turn settle, not process exit

Status: implemented
Partly-superseded-by: 2026-10-07-subagent-reply-admission.md
Partly-superseded-by: 2026-09-30-subagent-result-consumption-and-turn-delivery.md

## Problem

A background subagent lane's answer reached the parent only when the RPC child
process *exited*. `rpc-child.ts` marked the lane idle on `agent_end`, the
subagent plugin armed a five-minute keepalive timer, and the `subagent-result`
message was produced solely by `LaneRegistry.onSettled`, which fires when
`child.done` resolves — at process exit, meaning keepalive expiry. An answer
ready after one minute arrived ~six minutes late, and `subagent_tasks
wait`/`show` could not see it meanwhile (`lane.result` was unset). The bug was
invisible to tests because `lane-reply.test.ts` used a fake child that never
drove the turn boundary.

Two more defects shared the same root — `agent_end` was treated as the turn's
end, but in pi 0.85.1 it is only the model's last message: the session may
still auto-retry, auto-compact, or drain a queued prompt before
`agent_settled`:

- A `reply` landing in the `agent_end`→`agent_settled` window was sent as a
  bare `prompt` (no `streamingBehavior`), so pi could throw "Agent is already
  processing". The resulting `response { success: false }` line was swallowed
  as protocol noise and the tool still reported "Reply sent".
- The 15-minute wall clock armed once at spawn, so keepalive idle time and all
  later reply turns drew down one budget — an old lane's next turn could be
  killed with time it never spent.

The 2026-10-09 incident exposed a second confusion between task completion and
process exit. Two review lanes delivered completed answers at 09:27:43 (UTC+8),
then changed to failed at 09:32:58. Their raw logs contained 72/73 matched tool
start/end pairs, final assistant messages with stop reason `stop`, and one
`agent_settled` each; there was no later turn or background tool launch.
The five-minute idle keepalive called `end()`, which sent SIGTERM. The resulting
exit 143 was mapped as a new task failure and overwrote the settled answer.
The previous fake-child regression never emitted close 143, hiding this path.
The keepalive callback also lacked a fresh idle-state check, and stdin could
still accept a reply after termination had begun.

## Decision

**Turn boundaries move to `agent_settled`, each settled turn delivers its own
result, and the wall clock becomes per-turn.**

- `rpc-child.ts`: `agent_start` marks a turn active (`onIdleChange(false)`),
  clears the previous turn's `errorMessage` and `finalText` (a recovered lane
  must not report a stale failure, and a textless turn must not re-report the
  previous answer — the run's final outcome still holds the last turn's text
  because the reset happens only at the next start), and arms the per-turn
  `timeoutMs`; `agent_settled` ends the
  turn (`onIdleChange(true)`, wall clock cleared) and fires a new
  `onTurnSettled(result)` carrying that turn's outcome — `failed` when the
  turn's state has an error, else `completed`, with the final assistant text
  and cumulative usage. `agent_end` still folds into the stream state but no
  longer moves idle state. Idle time is bounded by the caller's keepalive, not
  this timer.
- Every `prompt` command is written with `streamingBehavior: "followUp"`, so pi
  queues it instead of throwing when it lands while a run is still finishing.
  Sent command ids are tracked to their type; a `response` line with
  `success: false` is routed to a new `onCommandError({ command, error })`
  instead of being dropped.
- `tool.ts`: the `AgentRunResult` → `AgentToolResult<SubagentDetails>` mapping
  at the end of `executeSubagent` is extracted as `toSubagentToolResult`, so a
  per-turn result renders identically to a final one.
- `LaneRegistry`: `setTurnResult(id, result)` stores the turn's result on a
  still-running lane and bumps `turnsAnswered`, notifying waiters; `waitFor`
  resolves `settled` when the lane is settled, when it has a result *and* is
  idle (`idleSince` set — a busy lane's `result` is the *previous* turn's
  stale answer), or when `turnsAnswered` grows past its wait-start value.
  Capacity counts only *busy* background lanes — an idle lane holds no slot,
  and a reply re-activating one is always allowed.
- `index.ts`: each turn settle delivers the `subagent-result` message through
  the existing `SettledDeliveryQueue`/`isCurrent` path immediately and records
  `deliveredTurns`; the final settle skips re-delivery only when the run
  completed and no turn settled after the last delivered one (failures, aborts
  and mid-turn timeouts still deliver). `onCommandError` lands on
  `lane.lastCommandError`, shown by `formatBackground`/`show`; an idle lane
  with a result reads "answered … — awaiting a reply".
- Idle retirement preserves a snapshot of the last settled turn, including its
  failure reason when that turn failed. This applies only to an explicit idle
  `end()`: unexpected exits, active cancellation, timeout and stall still use
  the normal outcome mapping. A new `agent_start` clears the old snapshot.
- Keepalive callbacks check timer identity, session generation, running state
  and the same idle timestamp. They call `end({ onlyIfIdle: true })`, whose
  transport guard refuses retirement during an active turn or after a prompt
  was admitted but before `agent_start` arrives. Termination closes command
  admission immediately, so a racing reply cannot be acknowledged into a
  process that is already being reaped.
- The goal-spend lease still finishes at final settle — per-turn delivery must
  not bill a goal twice.

## Alternatives considered

- **Keep process-exit delivery.** The answer would still arrive keepalive-late
  and `wait`/`show` would stay blind; this was the bug, not an option.
- **Shorten the keepalive.** Trades one delay for another and loses the reply
  window's purpose; it fixes nothing about `wait`/`show`.
- **Step-Code-style per-turn settle** (treat each `agent_settled` as a lane
  result while the process lives on). Chosen — it is the design above.
- **Resolve `waitFor` only on final settle.** Consistent but useless: a `wait`
  issued after the answer existed would park until its own deadline.
- **Clear `errorMessage` on `message_end` only** (which `applyEvent` already
  does). Kept, plus an explicit clear at `agent_start`: `error`-type events set
  it mid-turn without a `message_end`, and the per-turn contract needs a clean
  slate per turn regardless of which event produced the failure.

- **Ignore every exit 143.** Rejected: an unexpected SIGTERM must remain a
  failure. Only retirement explicitly initiated while idle preserves the
  settled result.
- **Fix only the Paseo card status.** Rejected: the incorrect failure lives in
  the registry and parent transcript too; rendering cannot repair it.

## Consequences

The answer latency for background lanes drops from keepalive expiry (default 5
min after the turn ends) to `agent_settled`. `wait` and `show` work on live
lanes. The wall clock no longer conflates turns, and refused replies are
visible instead of silently acknowledged. `turnsAnswered`/`deliveredTurns`
bookkeeping is the cost: it exists so a completed run that already delivered
does not send a duplicate, and its skip condition is deliberately narrow — any
non-completed final status or an undelivered turn still delivers.

`AgentRunResult.usage` on `onTurnSettled` is cumulative across turns by design;
callers needing per-turn deltas must subtract.

## Superseded

Child turn settlement, per-turn deadlines, RPC reply routing, command-error
visibility, idle capacity accounting, and final goal-spend settlement still
hold. The parent delivery mechanism is replaced by the successor note:
`resultRevision` distinguishes new answers from process-exit repeats;
`SubagentResultDelivery` steers unread results at the parent's `turn_end` and
uses its `agent_settled` only as a late fallback. Queries returning an answer
consume its pending notification. The old `deliveredTurns` field recorded
scheduling, not confirmed submission or proactive consumption.

## Superseded

Only the always-allowed idle-reply exception is replaced by
`2026-10-07-subagent-reply-admission.md`. Turn settlement, answer revisions,
idle observability, and freeing idle slots still hold.

## Verification

- `plugins/agent-runner/test/rpc-child.test.ts` — "onTurnSettled fires once
  per agent_settled with that turn's outcome", "a turn with an error settles
  as failed, and a recovered turn clears it", "a new turn does not re-report
  the previous turn's text", "the run's final text survives an idle gap
  between turns", "a failed command response reaches onCommandError instead
  of being dropped", "prompt commands carry streamingBehavior followUp so pi
  queues them mid-turn", "the wall clock is per-turn: idle time does not
  spend it, a long turn does", and the updated "idle change fires on turn
  boundaries" (idle now flips on `agent_settled`, not `agent_end`).
- `plugins/subagent/test/lane-reply.test.ts` — the "turn-settle delivery"
  block: immediate `subagent-result` delivery, `wait`/`show` visibility, no
  duplicate delivery on keepalive `end()`, second-turn delivery, mid-turn
  failure still delivering at final settle, idle lanes not holding a capacity
  slot, a `wait` on a busy next turn not resolving on the previous turn's
  answer, and refused commands surfacing on the lane.

Proved: with the implementation absent,
`bun test plugins/agent-runner/test/rpc-child.test.ts plugins/subagent/test/lane-reply.test.ts`
ran 28 tests → 17 pass, 11 fail (idle still flipped on `agent_end`,
`onTurnSettled`/`onCommandError` never fired, no `streamingBehavior`, the wall
clock was armed once, delivery waited for process exit, and an idle lane held a
capacity slot). Two review-round regressions were also seen red before their
fixes: a `wait` on a re-activated busy lane resolved instantly with the stale
previous answer, and a textless second turn re-reported turn one's text —
each new test failed once against the unfixed code and passes now.
After the fix the same command reports 31 pass, 0 fail.


2026-10-09 retirement verification:

- `plugins/agent-runner/test/rpc-child.test.ts` — idle cleanup exit 143/137/null
  preserves completion, settled failure keeps its original reason, unexpected
  143 still fails, active end/explicit terminate cancel, and idle-only end
  refuses active work and admitted replies awaiting `agent_start`. Replies
  sent after retirement starts are refused.
- `plugins/subagent/test/rpc-retirement.test.ts` — the real RPC transport runs
  through the registry and host publisher with a short keepalive and a fake
  process that exits 143 on SIGTERM. Completion survives retirement without a
  failed update or duplicate result. A reply stays alive before `agent_start`
  and during its active turn beyond the previous keepalive deadline.

Proved: before the retirement fix, the runner suite reported 28 pass / 3 fail
(completion on cleanup exit 143/137, and active end classified as failure).
Temporarily disabling the retirement-outcome branch made both cross-layer tests
fail (0 pass / 2 fail), including the literal exit-143 failure; the branch was
then restored. The additional command-admission assertion failed in all three
idle cleanup cases before its guard (0 pass / 3 fail). With the complete fix,
`bun test plugins/agent-runner/test/rpc-child.test.ts plugins/subagent/test/lane-reply.test.ts plugins/subagent/test/rpc-retirement.test.ts`
reports 53 pass / 0 fail.

The active/pending guard was also verified independently: removing the idle-only
guard made the active-turn assertion receive SIGTERM (0 pass / 1 fail); removing
only the pending-reply check made the admitted-reply assertion receive SIGTERM
(0 pass / 1 fail). Both mutations were reverted. The focused suite subsequently
passed 53 tests before concurrent run-core edits introduced a duplicate
readTokenUsage export, which blocked the later full-workspace test run and
subagent imports; the runner alone still passed all 32 tests. This unrelated
loader failure is not a green full-workspace validation.

Final validation: the concurrent duplicate export was subsequently corrected;
the 53-test focused suite and full-workspace typecheck passed again, and the
notes verifier passed. Full-workspace test retries remained red in unrelated
concurrent changes (bg-bash notification batching on one run, then paste-image
candidate-path expectations on the final run). The wider subagent suite was
176 pass / 1 fail at its Paseo RPC client opt-in test. The retirement regression
passed; these wider failures are reported rather than overwritten or suppressed.
