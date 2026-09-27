# Agent Note: Fail a silent child on a stall bound, not on the wall clock

Status: implemented

## Problem

A delegated child that wedged inside one tool call produced no event for as
long as the tool ran. The only bound on that was the wall clock
(`DEFAULT_AGENT_TIMEOUT_MS`, fifteen minutes), so the failure arrived at the
deadline with the diagnosis "The agent timed out after 900000ms" and nothing
else — the whole run budget spent, and no indication of *what* had gone quiet.

The case was reproducible. Two `explore` children in one session issued
`find {path: "/Users/me", pattern: ".workbuddy/**/*.info"}` and
`find {path: "/Users/me/Library", pattern: "**/*qoder*/**/*.asar"}`. pi's
`find` tool spawns `fd` and waits for `close` with no timeout of its own, so a
glob over a home directory is an unbounded traversal: the children sat at ~14s
CPU over nine minutes of wall time, emitting nothing. The fleet surfaces did
label them — `deriveChildState` promotes a quiet lane to `stalled` after 90
seconds and `formatBackground` prints `no child event for 4m39s (possible
stall)` — but a label is not an action, and the label was all there was. The
parent burned six minutes polling `wait`/`show`/`events` before cancelling both
by hand.

## Decision

**A second, shorter bound on silence, alongside the wall clock.** The executor
tracks a liveness clock that only a parsed child event moves, and fails the run
when it goes quiet for `stallMs`:

- `DEFAULT_STALL_MS` is five minutes; `PI_AGENT_STALL_MS` overrides it and `0`
  disables it. `resolveStallMs` reads the environment in `agent-runner` rather
  than in each plugin, so `pi-subagent` and `pi-workflow` cannot drift on what a
  stalled child means and the user has one switch.
- The check is *sampled* via `stallCheckIntervalMs` (at most every 5s and at most
  a quarter of the threshold) rather than re-armed per event. Re-arming per event
  would charge a streaming child one timer per token; sampling costs one
  comparison per interval.
- The failure is `status: "failed"` with the last event named, built by
  `stallFailureMessage`: `The agent produced no output for 300000ms (last event:
  tool_start find); killed by the stall bound; its event stream is at …`.
  `describeAgentEvent` produces that label and is deliberately allowlisted by
  event type — it carries a tool *name*, never tool arguments.
- The RPC transport suspends the bound between turns. An idle lane is waiting
  for its owner's `reply`; that silence is expected, and it is already bounded
  by the keep-alive window. `agent_start` re-arms it, so a lane stays bounded
  across every turn of a conversation.

**A tool that declared its own timeout outranks the bound while it runs.**
`trackDeclaredTimeouts` reads `args.timeout` (pi's shell tools take seconds) on
`tool_execution_start`, lifts the bound to that budget plus a 30s slack, and keys
it by `toolCallId` so only that call's `tool_execution_end` drops it. The keying
is not decoration: pi runs a tool batch in parallel by default
(`@earendil-works/pi-agent-core/dist/agent-loop.js`, `executeToolCalls` takes the
parallel path unless `config.toolExecution === "sequential"` or a member of the
batch declares `executionMode: "sequential"`, and no builtin sets it —
`tool-definition-wrapper.js` only passes the field through), so one shared slot
let a short `read` finishing first strip the exemption from the long silent
`bash` still in flight.
A turn boundary clears whatever is left, because a call that never reported an
end would otherwise exempt the rest of a lane's life. `stallThresholdMs` is the
one question both transports ask of the result. This is what stops the new bound
from fighting the budget this repository already had: `pi-workflow`'s child guard
injects `PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS`, ten minutes by default, and pi's
shell tool emits progress **only when the command prints** (`bash.js`: `onUpdate`
is called from `handleData` and gated on `updateDirty`) — so a legitimate silent
ten-minute command produces no events at all and would have been killed at five
minutes by a bound that knew less than the command did. With the composition, the
shell budget stays authoritative for shells and reports its own timeout, while a
tool that declared nothing is still caught at five minutes.

**The first reason to end a run owns its label.** The deadline can expire inside
termination's grace period, so the wall-clock callback and the abort handler both
check `settled || killedBy` before assigning one. Without that, a stalled child
whose 1s grace outlasted a shorter `timeoutMs` was reported as "timed out" — the
same class of misreporting as the `wait` fix in
`2026-09-27-subagent-wait-cap-and-interrupt.md`.

**The trade is deliberate and recorded here:** a single tool call that runs
silently for more than five minutes is now killed where it previously had ten
more minutes to finish. That is the point — such a call is an outlier against a
fifteen-minute run budget, and failing it early with the tool named is more
useful than failing it late with nothing. A caller that genuinely needs a longer
silent tool raises `PI_AGENT_STALL_MS`, sets it to `0`, or — better — declares a
`timeout` on the tool call, which the bound now honours.

## Alternatives considered

- **Only surface the stall, never act on it** (keep the 90s label, add a
  push notification to the model). Zero risk of killing legitimate work, and it
  does fix "the model cannot see the stall without polling" — but it leaves the
  lane holding one of four background slots until the wall clock, which is half
  of the reported problem. Worth doing later as well, not instead.
- **Two thresholds by phase** — a short one while a model turn is streaming
  (a turn that emits nothing is definitely wedged) and a long one while a tool
  is in flight (it might be a build). Rejected in favour of the declared-timeout
  composition: the case that matters is the tool phase, so a short threshold
  cannot be the one that acts on it, and a second knob would have to be kept in
  step with the shell budget the repository already has.
- **Re-arm a timer on every event.** Correct, but it makes the cost of a
  streaming child proportional to its token count, in the one process that is
  already parsing that stream.
- **Bound the child's tools instead** (drop `find` from `explore`, or pass a
  per-tool timeout). The plugin cannot reach into the child's tool set, and the
  child's own choices are not the plugin's to enumerate; a bound on the child is
  the layer that owns the failure.

## Consequences

A wedged child now fails in about five minutes with an actionable message
instead of fifteen minutes with none, and `PI_AGENT_STALL_MS` is the documented
escape hatch. `pi-workflow` gets the same behaviour for free, which is the point
of the shared runner — as it does the declared-timeout composition, so its shell
budget and this bound no longer disagree. `stallMs` is an explicit field on
`AgentRunInput`, `AgentExecutorOptions`, `RpcChildInput` and
`SpawnRpcChildOptions`, so a caller that measured its own budget can override the
ambient value.

The bound is a heuristic: it cannot distinguish a wedged tool call from a slow
one that declared nothing. The evidence file is still the ground truth — the
failure message names it so the raw stream can be read after the fact.

Every sampling rule, failure message and composition rule now has one definition
(`stallCheckIntervalMs`, `stallFailureMessage`, `timeoutFailureMessage`,
`stallThresholdMs` and `trackDeclaredTimeouts`, all in `src/executor.ts` and
imported by `src/rpc-child.ts` rather than restated there — they are shared
internals, not part of the package's exported surface), because this change first
shipped with the sampling formula and both messages written twice — precisely the
divergence `agent-runner/README.md` names from the last time this code was in two
copies.

## Verification

- `plugins/agent-runner/test/executor.test.ts` — "a child that stops emitting is
  failed by the stall bound, naming the last event": a fixture child emits
  `tool_execution_start find` and then nothing; the run must fail on the stall
  bound, name `tool_start find`, and not say "timed out".
- `plugins/agent-runner/test/executor.test.ts` — "the stall bound is off when
  stallMs is zero" leaves the wall clock as the only limit, and "the environment
  sets the stall bound, and an explicit value wins over it" plus "the stall label
  names a tool but never carries its arguments" pin the resolution order and the
  allowlist.
- `plugins/agent-runner/test/rpc-child.test.ts` — "a turn that goes quiet is
  failed by the stall bound, naming the last event", "an idle lane is not
  stalled: silence between turns is expected" (which also proves `agent_start`
  re-arms the bound), "a turn whose tool declared its own timeout is not killed
  by the silence bound" (the RPC call site of the composition rule, pinned
  separately because a rule wired on one transport only is the same mistake), and
  "the first bound to fire owns the label, even when the wall clock expires
  during the grace period".
- `plugins/agent-runner/test/executor.test.ts` — "both transports share one
  sampling rule and one failure message" (both messages asserted verbatim),
  "a declared timeout is tracked per call, and only its own end drops it" (the
  keying, the turn-boundary clear, and `stallThresholdMs`),
  "a tool that declared its own timeout outranks the silence bound while it runs"
  (the wall clock, not the silence bound, must be what ends it),
  "a parallel sibling finishing does not strip a long call's declared budget", and
  "a tool that declared nothing is still caught by the silence bound".
- `plugins/agent-runner/test/rpc-child.test.ts` — "a parallel sibling finishing
  does not strip a long call's declared budget" (the RPC twin; the composition is
  wired on both transports, and a rule wired on one is the same mistake).

Proved: each rule was reverted on its own, and each on its own is red.

- With `const stallMs = 0` forced in `executor.ts`, the executor stall test fails
  in 8008ms — the run reaches the 8s wall clock and reports "timed out" instead
  of the stall message. With the same edit in `rpc-child.ts`, the two RPC stall
  tests fail at their 10s test timeout, i.e. the lane hangs, which is the original
  bug.
- With `stallThresholdMs(stallMs, declaredBudgets)` reduced to `stallMs` in
  `executor.ts`, "a tool that declared its own timeout" fails in 198ms: the
  silence bound kills the call the command's own budget was meant to own. The
  same edit in `rpc-child.ts` fails the RPC twin in 1305ms.
- With the keying dropped — `budgets.delete(event.toolCallId)` back to
  `budgets.clear()`, replicating the single slot this change replaces — the
  keying unit test fails in 1.66ms, "a parallel sibling finishing does not strip a
  long call's declared budget" fails in 194ms on the executor transport and
  1303ms on the RPC transport, and the RPC sibling test reports "produced no
  output" where the wall clock should have owned the failure. Note that the
  *single-call* declared-timeout tests still pass under that revert on both
  transports: only the parallel sibling test discriminates, which is why the
  batch case needed an end-to-end twin and not just the unit test.
- With the `settled || killedBy` guard removed from the wall-clock callback in
  `rpc-child.ts`, "the first bound to fire owns the label" reports `timed out`
  for a run the silence bound had already ended. This one is worth reading twice:
  before the guard existed it made the keying red run *pass*, because the wrong
  label happened to be the one under assertion.
