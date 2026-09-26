# Agent Note: Background lanes ride the RPC transport and take replies (P2)

Status: implemented

## Problem

The delegation lifecycle was one-shot: a background child's process exited
when its turn ended, so "ask the child one more thing" meant spawning a
fresh agent and re-stating all context — the gap Step-Code's `agent_send`
and minimax's `task_append` filled. The plan's answer was an RPC child, not
a persisted session: `pi --mode rpc --no-session` keeps stdin open for
`prompt`/`steer`/`follow_up`/`abort` while preserving the `--no-session`
contract (no `/resume` pollution, and `PI_SUBAGENT_DISABLE` still travels
in env, so the one-level fan-out bound is untouched).

## Decision

**Two transports, one contract.** `agent-runner`'s `rpc-child.ts` mirrors
`executor.ts`'s lifecycle — same `agentChildEnv`, stdout drain, wall-clock
kill, evidence file, and `finish()` outcome mapping — with three deliberate
deltas:

- stdin is `"pipe"`, not `"ignore"` — it is the control channel; all writes
  go through `send()`.
- `--mode rpc` instead of `--mode json -p` — `agent_end` marks a *turn*
  boundary, not the run's end, so the child stays alive for follow-ups.
- `done` resolves only when the *run* ends (caller `end()`/`terminate()`,
  deadline, abort, or exit) — never on `agent_end`.

`executeSubagent` selects the transport through `ctx.rpc`: providing it
means "run this child live, hand me the handle". An injected `executor`
seam still wins — that ordering is pinned because eleven tests depended on
it and got it wrong once.

**Reply semantics by lane state.** `subagent_tasks reply` maps onto the
child's actual turn state, not a queue:

- idle lane (turn ended, child alive) → `prompt` starts a new turn; the
  lane's `idleSince` mark clears immediately so a second reply in the same
  tick cannot misfire as another fresh turn.
- mid-turn, `interrupt: true` → `steer` (after the current tool calls).
- mid-turn, default → `follow_up` (queued until the turn ends).
- settled, foreground, or no live channel → an explicit refusal, never a
  silent no-op.

**KeepAlive bounds the liveness.** An idle lane would otherwise hold a
process open forever. `PI_SUBAGENT_KEEPALIVE_MS` (default 5 min) ends an
idle lane's child, settling it with its last answer — a fire-and-forget
caller is never held open. The 15-minute run timeout still bounds the
whole lane across turns.

**`idle` is a first-class observability state.** `deriveChildState`
returns `idle` when `idleSince` is set — it wins over `stalled` because a
child waiting for its owner is not stuck. `WorkState` gained `"idle"`
(◌, muted) so the widget, panel row, and `formatBackground` all show the
same thing: `· idle for 12s — awaiting a reply`.

## Alternatives considered

- **Persisted child sessions (`--session`)**: already priced and rejected —
  `/resume` pollution plus `PI_SUBAGENT_DISABLE` not travelling with a
  session file would silently bypass the fan-out bound. RPC gets the
  continuation without either cost.
- **A `ChildTransport` abstraction file**: the plan sketched
  `src/transport.ts`; the actual seam turned out smaller — `ctx.rpc` on
  `executeSubagent` plus `options.spawnRpcChild` for tests — so it stayed
  inline in `tool.ts` rather than becoming a parallel interface that would
  drift.
- **`stop()` writing `abort` over stdin**: unnecessary — the lane's own
  abort signal already reaches the child through `input.signal`, which the
  RPC child's `onAbort` maps to `killedBy="abort"` + SIGTERM, same as the
  JSON child.

## Consequences

A background lane is now an addressable process: the model can `reply`,
`wait`, or `cancel` it, and the panel shows `◌ idle` between turns. Every
prior contract holds: `--no-session`, `SCHEDULER_DISABLE_FLAGS`, the
4-lane cap, evidence logs (RPC `response`/`extension_*` lines are dropped
from the fold but still land in the evidence file). Foreground calls keep
the JSON transport — a one-shot call deserves the simpler pipe.

## Verification

- `plugins/agent-runner/test/rpc-child.test.ts` — prompt goes over stdin
  not argv; `agent_end` does not settle the run; `end()` maps to
  completed; `terminate()` to aborted; idle flips fire on turn boundaries;
  `send()` refuses after finish.
- `plugins/subagent/test/lane-reply.test.ts` — steer/follow_up/prompt
  selection by state, idle-mark clearing, dead-channel and settled-lane
  refusals, keepAlive expiry ends the child.
- `plugins/subagent/test/transport.test.ts` — foreground never touches
  RPC; an injected executor seam still wins over `ctx.rpc`.
- Red-run: the executor-seam precedence bug produced 11 failures across
  background-path tests until `ctx.rpc && !options.executor` fixed the
  ordering — the ordering is now pinned by `transport.test.ts`.

137+5 tests pass across both packages, `bun run typecheck` clean.
