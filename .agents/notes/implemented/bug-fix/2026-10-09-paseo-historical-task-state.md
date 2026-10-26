# Agent Note: Historical subagent cards display the current task state

Status: implemented

## Problem

A background launch result is permanently stored as running. The later
subagent-update adds a completed card but does not change that launch result.
Rendering only each row's own data leaves contradictory Running and Completed
cards for the same task, including after reopening the conversation.

## Decision

Treat subagent cards as views of a task entity. Share one timeline observation
per parent conversation under each host's plugin contribution. Subscribe first,
then read paginated canonical history, retaining only the latest task evidence
by timeline sequence. Recognize visible assistant/status-tool rows, hidden
progress evidence and metadata-only native subagent updates. All mounted cards
for that task subscribe to the same latest state. Each transformed subagent card
also carries its original timeline source. Elect one visible source per task:
prefer the spawn row, then a status row, then a task-inspection fallback. All
references still contribute state, but duplicate disclosures render nothing.
Recompute ownership from canonical history, not mounted components. Retain the
latest sequence for a foreground tool that becomes a native answer, so stale
history cannot resurrect its former progress card. The terminal status becomes
the visible fallback in that case.

Preserve each card's original task title and description. Overlay only execution
status, activity, tool count and transcript reference. Keep the transcript and
its persisted messages unchanged. Reopening reads persisted timeline history,
even when the completion row is not mounted and raw evidence logs have expired.

Live evidence wins over older reads. Reconnection rereads missed history;
replacement epochs invalidate old state. A genuinely newer reply can return a
task to running. Release the shared subscription and discard pending results
when the final card unmounts; plugin disposal clears all observations.

## Alternatives considered

- Change Running to Started everywhere: avoids a misleading label but loses
  current execution status on the task cards.
- Mutate historical tool results: changes the evidence record for a rendering
  concern and requires private host APIs.
- Collect only mounted completion cards: virtualization and cold reopening can
  leave the later row unmounted, so the launch card stays stale.
- Infer completion from agent_end in the raw log: a child may remain alive for
  replies, fail after a turn, or have its evidence log pruned.

## Consequences

History can retain multiple references to the same task; one disclosure displays
the current execution state while preserving its original description. A query
still displays a fallback card when no launch/status card is available. The
companion does not rewrite the underlying timeline or hide native answers. State
recovery uses the public Paseo timeline API, with 200 entries per page and one
shared subscription rather than one poller per card. Read failures retain the
last confirmed state and retry; they never imply successful completion. Bash,
Workflow and Goal card behavior remains unchanged.

## Verification

- `integrations/paseo-ui/test/task-status-store.test.ts::one task keeps one status card across launch, failed inspection and terminal update`
- `integrations/paseo-ui/test/task-status-store.test.ts::a foreground tool returning its answer releases the card to the terminal status`
- `integrations/paseo-ui/test/card.test.tsx::duplicate inspection and status references render exactly one task disclosure`

- `integrations/paseo-ui/test/card.test.tsx` checks current completed, failed and
  cancelled labels on the actual historical launch card renderer while keeping
  its original task description and showing the new tool count.
- `integrations/paseo-ui/test/task-status-store.test.ts` covers cold paginated
  history, live completion during a stale read, newer reply execution, parent
  conversation isolation, reopening, reconnection, epoch replacement, hidden
  progress, native metadata and release after the final observer leaves.

Proved: before adding the latest-state overlay, the new historical-card tests
failed for all three terminal states: the rendered card still contained Running
and Background, and lacked the expected terminal label and tool count. The red
run recorded 3 pass / 3 fail. After the fix all six card tests and the companion
suite pass, including persisted-history and subscription lifecycle tests.

Proved: before source ownership was implemented, the two new store regressions
failed: inspection/status rows had no shared visible source, and a foreground
card could not hand off to its terminal status. Output is saved in
`regression-evidence/paseo-task-card-dedup-red.txt`. The companion suite passes
after the fix, including fallback visibility, late history and terminal state.

Proved: temporarily disabled the duplicate-render guard; the actual renderer test
failed because the inspection produced a second Subagent disclosure instead of
empty markup. Saved output to `regression-evidence/paseo-task-card-render-red.txt`,
restored the guard and reran the same test green. Cold paginated replay also
keeps an answered foreground row native instead of resurrecting its live card.
