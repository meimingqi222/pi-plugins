# Agent Note: A foreground call gets the evidence file and the refusal a background lane has

Status: implemented

## Problem

P1 made a foreground `subagent` call a lane so the fleet could show it, but two
parts of the lane contract were never extended to it.

1. **No evidence file.** Only the background path passed `evidencePath` and
   called `registry.setLogPath`; the foreground path passed neither. The
   executor's own comment says a hung agent "is otherwise undiagnosable after
   the fact" — and the lane that most needs that file is the foreground call,
   because it is the one that blocks the session's turn. In the panel, `t` and
   `l` on a foreground row always answered "No raw log is available for this
   task."
2. **`k` was a silent no-op.** `LaneRegistry.stop` returned `false` for a
   foreground lane, and `panel.ts` ignored the result while `LIST_KEYS`
   advertised `k cancel`. The key looked broken, and the model's
   `subagent_tasks cancel` described the same refusal as "already settled" —
   which is a different fact and a wrong one.

## Decision

**Give the foreground lane the same evidence and the same honest refusal.**

- The foreground launch computes `subagentLogPath(id, sessionId)`, registers it
  with `registry.setLogPath`, and passes `evidencePath` plus
  `evidenceMaxBytes: SUBAGENT_LOG_MAX_BYTES` — the identical pair the background
  path uses, so one reader (`readSubagentLog`) serves both.
- `LaneRegistry.stop` returns a `StopOutcome` — `"stopped" | "settled" |
  "foreground"` — instead of a boolean. `"foreground"` is a distinct answer
  because a foreground call is the session's own turn: there is no child to
  abort behind the model's back, and the only thing that ends it is interrupting
  the turn.
- Every surface reports that answer: the panel notifies "… is this session's own
  foreground call — press Esc to interrupt it" through a new optional
  `PanelDeps.notify`, `/subagents stop` splits its count into cancelled and
  left-to-Esc, and `subagent_tasks cancel` says so in words rather than claiming
  the task had settled.

## Alternatives considered

- **Stop offering `k` on foreground rows.** The footer is per-view, not
  per-row, so this means either a row-dependent footer or no `k` at all — and
  the panel would still have nothing to say about *why*. A reported refusal is
  more useful than a hidden key.
- **Let `stop()` abort a foreground lane.** It would work mechanically
  (`registry.abort` already reaches any lane), but it would silently kill the
  parent's own in-flight tool call — an action the user takes with Esc, with the
  turn's context in front of them.
- **Give the foreground lane a `taskId` in its tool result.** It would make
  `cancel`/`wait`/`reply` addressable, but a blocking call has no "later": the
  model is inside the call until it returns, so an id would only be usable from
  a concurrent tool call in the same message. Not worth widening the contract.
- **Keep `stop()` boolean and add a separate `canStop()`.** Two calls that can
  disagree; the union makes the caller handle the foreground case.

## Consequences

A wedged foreground call now has a raw event stream to read afterwards, which is
the case the stall bound's message points at when it names the evidence path.
The panel's `k` explains itself instead of doing nothing, and the model's
`cancel` no longer misreports a foreground call as settled.

The foreground lane still has no log *until* the launch registers it, so a lane
created by an embedded host that calls `registry.launch` directly (tests) has
none — the path is set by the caller, as before.

## Verification

- `plugins/subagent/test/plugin.test.ts` — "a foreground call writes the same
  evidence file a background lane does" (the executor seam receives a
  `.jsonl` path under the configured log dir, carrying the session id, and the
  file is readable) and "cancel explains a foreground call instead of reporting
  a settled lane" (the refusal says `foreground call`, and the lane is still
  running afterwards).
- `plugins/subagent/test/panel.test.ts` — "k on a foreground row reports the
  refusal instead of looking broken" and "k on a background row stays silent".
- `plugins/subagent/test/lane.test.ts` — "stop refuses a foreground lane but
  abort() reaches it internally" now asserts `"foreground"`, plus a new
  "stop reports a settled lane rather than pretending it cancelled one".

Proved: with `evidencePath`/`evidenceMaxBytes` removed from the foreground
launch, with `stop()` back to a boolean answer, and with the panel's notify
disabled, the new tests fail in 3ms, 2ms and 0.83ms respectively. Restoring all
three turns the suite green at 103 tests.
