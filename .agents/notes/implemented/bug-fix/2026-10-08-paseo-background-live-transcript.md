# Agent Note: Publish an append-only background child transcript at launch

Status: implemented

## Problem

Subagent output files were published only at settlement. Paseo could identify
a running child, but its child page had no transcript to follow until the work
finished. Passive custom messages cannot solve this during a parent turn:
Pi defers them. Paseo's running subagent tool adapter also maps progress to
`sub_agent.log`, rather than the generic tool output field.

## Decision

RPC background spawn results carry an `Output file:` line at launch. The file
starts with the task and appends bounded completed assistant/tool messages as
they arrive. Paseo's existing adapter attaches its file follower immediately.
Settlement appends the summary to the same file before publishing the final
status. Reaching the native preview budget immediately appends a visible limit
notice and closes admission for new messages; later smaller records cannot
slip through. At most twenty admitted tool calls may drain single-text results
bounded to 32 KiB each, using the headroom below Paseo's 2 MiB / 200-item read
limits. This keeps an admitted call paired even when its result crosses the
ordinary 1 MiB / 150-weight preview budget. Results for omitted calls are never
published. At settlement, pending preview calls receive an explicit explanation
that their result was unavailable before the final task status. Bounded completed
snapshots remove incomplete call fragments from either end of the window. If a
result's call was evicted, retain its output as clearly labeled assistant text
instead of an orphan tool row; do not invent a command to make it parse. Follow-up turns get a new file, announced through Paseo's existing
runtime child-session notification. Foreground progress cards use the host's
`sub_agent.log` mapping, as recorded in the status-tool-rows note.

## Alternatives considered

- Publish a new snapshot on every progress tick: creates many files and does
  not let a follower stay attached to one append-only source.
- Wait for passive custom messages to flush: preserves the reported delay.
- Change foreground calls into background launches: changes model-facing
  execution and answer delivery semantics merely to register a host file.
- Change Paseo's adapter: outside the authorized scope.

## Consequences

Live background files are private, bounded to the host's byte/item budget,
and closed per turn. A native preview remains finite; its limit notice is not a
liveness signal. It points users to the parent task's output button or a parent
status check, rather than silently looking frozen. The companion output screen
continues reading the raw event log independently of this native preview. Existing foreground immutable snapshots remain supported.
Filesystem errors cannot fail child execution. Completed messages stream;
individual model text tokens are not copied into the child file.

New tool launches are background-only, as recorded in
`2026-10-08-subagent-background-default.md`; no foreground host adapter change
is required. Older hosts without file following show transcripts at settlement.

## Verification

- `plugins/subagent/test/host-transcript.test.ts::a full live preview announces its limit immediately and never admits an orphan result`
- `plugins/subagent/test/host-transcript.test.ts::admitted tool batches drain bounded results and settlement within Paseo read limits`
- `plugins/subagent/test/host-transcript.test.ts::bounded completed snapshots omit tool results whose calls fell out of the retained window`
- `plugins/subagent/test/host-transcript.test.ts::settlement closes an admitted tool whose result never arrived`

- `plugins/subagent/test/host-transcript.test.ts` pins launch-time availability,
  append-only updates, terminal summaries, private permissions, turn rotation
  and bounded output.
- `plugins/subagent/test/paseo.test.ts` verifies the actual extension's
  background launch exposes a readable file before the child completes.

Proved: adding the live transcript regression before implementation made
`bun test plugins/subagent/test/host-transcript.test.ts` report 1 fail and 3
pass because `startLive` was absent. After implementation all cases pass.
A separate integration check imported the actual Paseo adapter and file
follower from the reference checkout and verified a background launch,
background tool call, background tool result and final settlement in order.

Proved: the pre-fix implementation failed all three new limit/pairing regressions:
no running-time limit notice, lost admitted results and an orphan result at the
start of the bounded snapshot. Saved output:
`regression-evidence/subagent-preview-red.txt`. Restoring the pre-fix source for
the pending-tool regression left its call unresolved after cancellation; output
is in `regression-evidence/subagent-preview-settlement-red.txt`. Restored the fix
and reran the complete transcript file green. A read-only integration with the
actual Paseo source mapper read twenty completed shell tools, the limit notice
and final answer (106 events, about 486 KiB), all below its reader limits.
