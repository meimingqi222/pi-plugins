# Agent Note: Render Pi work status from the rows and tool calls Paseo actually emits

Status: implemented
Partly-superseded-by: 2026-10-08-paseo-background-live-transcript.md

## Problem

The companion claimed status text only from `assistant_message` items. Paseo 0.11.1 changed how a Pi
custom message reaches the app: `1f8a4559` ("fix(providers): show custom context in expandable tool
rows") replaced `item: { type: "assistant_message", text }` with `mapCustomMessageToToolCall`, which
emits a synthetic completed `tool_call` whose `name` is the custom type, `detail` is
`{ type: "plain_text", text }` and `metadata.customType` repeats the type. So every published state
rendered as a plain expandable row instead of a card, and the transformer matched nothing on hosts
from 0.11.1 on.

The second half of the report was timing. Pi queues `sendMessage(..., { triggerTurn: false })` while
the session streams and flushes it at the end of the turn (`agent-session.js`,
`_pendingCustomMessages`), which is why a blocking subagent call showed no state until it settled.
The same five lines were already reaching the host live: Pi's `onUpdate` partial result becomes the
parent `subagent` tool call, and Paseo's pi subagent adapter puts that text in `detail.log`
(`extensions/pi-subagents`, `mapSpawn`, giving `detail.type === "sub_agent"`). Nothing rendered it.

## Decision

`integrations/paseo-ui/client/transform-status.ts` exports `transformStatusToolCall`, registered on
`tool_call`. It claims the text from two carriers and otherwise returns `undefined` so the row keeps
its native renderer:

- a synthetic status row: `metadata.customType` is `pi-work-status` or `subagent-update` with
  `detail.type === "plain_text"`, which covers goal, workflow, bg-bash and subagent on hosts from
  0.11.1;
- a `subagent` tool call whose `detail.log` carries the five lines (`detail.type === "sub_agent"`),
  which is the live card during a blocking call; once the child settles that field holds its answer
  instead, so the row returns to native with its expansion and transcript link intact.

The `assistant_message` transformer stays for hosts up to 0.11.0, where a custom message still became
assistant speech. Both custom-message carriers hide `Subagent running` snapshots
by returning an empty item list, including during history replay. The native
running tool row remains a live card; terminal custom messages remain cards.
Foreground runs with an `onUpdate` callback also publish their running custom
messages with empty content and `display: false`, retaining correlation metadata
while progress updates only the existing tool row.

## Alternatives considered

- Keep only the `assistant_message` transformer and document the plain rows: every host from 0.11.1
  on would show no cards at all, which is the reported failure.
- Read the status from `metadata.details` instead of the row text: that payload carries lowercase
  work kinds and no `data` field, so it does not satisfy the renderer schema, and it duplicates the
  text the row already holds.
- Push the live card from a server entry with `timeline.append`: the daemon-side source would be the
  same tool-call partial result, at the cost of a second rendering path, a subprocess, and duplicate
  rows where the transformer already covers every host.
- Publish the child transcript snapshot on every progress tick so the child page fills in live: the
  app reads each immutable path once, so this needs a new path per tick, which collides with the
  200-file retention already noted for terminal snapshots.
- Read the live text from the unadapter-mapped tool detail (`detail.output`, as a running call looks
  before a subagent adapter maps it): the adapter's mapping wins, so the text arrives in
  `detail.log` with `detail.type === "sub_agent"`, which is what the shipped transformer reads.
- Claim any running tool call whose text parses: a `bash` row running a command that prints status
  lines would lose its native output view. Carriers are named instead.

## Consequences

Cards render again on hosts from 0.11.1, and a blocking subagent call shows progress while the child
works. During the run the row is a card; the native row, its expansion and its transcript link return
when the child settles, followed by a terminal card. Intermediate subagent status
snapshots no longer replay as a stack of stale Running cards. Other work kinds
retain their status cards. Background lanes still show no parent progress cards
until the next turn boundary, because only notifications stream for them and the app refuses
transformers on `notification` items. The child page still hydrates at terminal boundaries only.

## Superseded

The background child-page timing limitation above is replaced by the append-only
launch-time transcript in the successor. Hosts with file following now receive
background tool messages while the child runs. Status-message deferral and the
foreground child-page registration limitation still apply; the parent live card
and the host row mapping described here remain current.

## Verification

- `integrations/paseo-ui/test/status.test.ts::a custom status message renders as a card on hosts old and new`
- `integrations/paseo-ui/test/status.test.ts::a running subagent tool call streams the same card while the child works`
- `integrations/paseo-ui/test/status.test.ts::tool rows that are not status keep Paseo's native renderer`
- `integrations/paseo-ui/test/contribution.test.ts::the Paseo app client accepts every timeline transformer this companion registers`
- `integrations/paseo-ui/test/status.test.ts` covers hidden replayed running
  snapshots with live tool updates and terminal cards preserved.
- `plugins/subagent/test/host-progress.test.ts` covers silent foreground custom
  messages with streaming partial results, correlation and terminal visibility.

Proved: with `transformStatusToolCall` stubbed to return `undefined`, the two new tests failed
(no card for the synthetic `pi-work-status` and `subagent-update` rows, and no card for the running
`subagent` row) while the native-renderer test passed. Restored the implementation and the file
passed 16 of 16, the package 20 of 20. Output: `regression-evidence/paseo-live-status-red.txt`.

Payload and timing evidence, from a raw `pi --mode rpc` capture of one foreground subagent call
(`regression-evidence/paseo-rpc-stream.txt`): the tool call streams the five-line status at
T+4340ms and T+6345ms, the child settles at T+9172ms, and all three `subagent-update` custom
messages arrive in one batch at T+9173ms.

Live host evidence (`regression-evidence/paseo-live-daemon.txt`): the same run repeated against the
running Paseo 0.11.1 daemon through the public SDK, with the shipped transformer applied to the
daemon's own timeline items. The `subagent` row reported `status=running`, `detail=sub_agent` at
T+4024ms and T+22173ms and produced a running card from `detail.log` while the child was still
working (the child slept 12s); at T+23204ms the settled row's log held the child's answer and the
transformer left the row native; the three deferred `subagent-update` plain-text rows produced
running, running and completed cards at T+23205ms. The probe agents were deleted afterwards.

Proved: before the snapshot visibility fix, the new history-replay and foreground
progress regressions failed, together with the updated subagent message expectation
(18 pass, 3 fail). After the fix the same two files report 21 pass, 0 fail. The
four running snapshots in the screenshot scenario now produce zero historical
cards; the live tool still produces one card and completion produces one terminal card.
