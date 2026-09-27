# Agent Note: Answer an RPC child's extension dialogs instead of deadlocking on them

Status: implemented

## Problem

Background subagent lanes moved from `pi --mode json -p` to `pi --mode rpc` so a
child could survive its own turn and take a `reply`. The two modes do not hand an
extension the same UI context:

- A print/JSON child gets `noOpUIContext`, whose dialogs resolve immediately —
  `confirm` → `false`, `select`/`input`/`editor`/`custom` → `undefined`.
- An RPC child gets the real RPC UI context. Its dialogs emit an
  `extension_ui_request` on stdout and then **wait for an `extension_ui_response`
  on stdin**, with no timeout unless the caller passed `opts.timeout`.

`RpcChild.send()` writes exactly four command types — `prompt`, `steer`,
`follow_up`, `abort` — and nothing in this repository ever writes an
`extension_ui_response`. So a single dialog opened by any extension loaded in the
child blocked that child until its wall clock: fifteen minutes, reported as a
generic timeout, with the cause invisible from the parent. Every background lane
was exposed; foreground calls were not, because they keep the JSON transport.

The trigger is not exotic: pi's bundled `llama` extension uses `ctx.ui.select`
and `ctx.ui.confirm`, and `examples/extensions/project-trust.ts` uses
`ctx.ui.select`. A confirmation prompt from any installed extension is enough.

## Decision

**The RPC child answers dialogs the way the no-op context would.** The stdout
loop recognises `extension_ui_request` and, for the four methods that *wait*
(`select`, `confirm`, `input`, `editor` — the documented dialog set), writes back
`{ type: "extension_ui_response", id, cancelled: true }`. pi parses `cancelled`
as the default for every one of those methods, so the child sees exactly what a
JSON child sees: no UI, dialogs declined, the run continues.

- Fire-and-forget requests (`notify`, `setStatus`, `setTitle`, `setWidget`, …)
  are left unanswered on purpose. They have no pending entry, and answering one
  would misstate the protocol.
- `custom` is *not* a dialog method in RPC mode — it returns `undefined` without
  emitting anything — so it is not in the set. Adding it would be dead code that
  reads like a supported path.
- The responder shares the one stdin write path with the control commands
  (`write`), so framing, id generation and backpressure cannot diverge between
  them. `send` is now a thin, type-restricted wrapper over it.
- A UI request still counts as child liveness: it is a parsed event, so it moves
  the stall bound's clock.

## Alternatives considered

- **Keep the JSON transport for background lanes.** That would delete the
  deadlock and the `reply` feature with it — the whole point of P2.
- **Detect the dialog and fail the lane with a clear message.** Honest, but it
  turns "an extension asked a question" into a failed delegation. Declining is
  what the child would have got under JSON mode, so declining preserves the
  transport's behaviour instead of inventing a third outcome.
- **Add a timeout to the dialog instead of answering it.** The timeout belongs to
  the caller of `ui.confirm`, inside the child, and the plugin cannot set it. A
  parent-side timer would only convert the deadlock into a slower deadlock.
- **Answer `notify`/`setStatus` too**, for symmetry. They are notifications, not
  requests; there is nothing to answer, and pi drops a response whose id has no
  pending entry.
- **Turn extensions off in the child (`--no-extensions`).** The spawn
  deliberately loads ambient extensions — a child may be asked to use one — and
  the one-level fan-out rule is enforced by environment flags, not by removing
  extensions. Disabling them would be a much larger behaviour change than
  answering a dialog.

## Consequences

A dialog inside a background child no longer hangs the lane; it is declined and
the run continues, matching the JSON child's behaviour. The cost is that an
extension in a child can no longer *ask* anything — but it never could, since
nothing was answering. `pi-workflow` children run JSON mode and are unaffected.

The responder is deliberately not a general RPC client: it answers the dialog
methods and ignores everything else on the stream, so an RPC feature the plugin
does not model stays dropped rather than half-handled.

## Verification

- `plugins/agent-runner/test/rpc-child.test.ts` — "a dialog request is cancelled
  instead of pinning the child forever": `confirm` and `select` requests each get
  an `extension_ui_response` carrying their own id and `cancelled: true`, while a
  `notify` request gets none.

Proved: with the `answerExtensionUi(event)` call removed from the stdout loop,
that test fails in 22ms — no response is written for either dialog. Restoring the
call turns it green; the other eight `rpc-child` tests are unaffected, which is
what shows the responder is additive to the existing stdin protocol rather than a
second command path.
