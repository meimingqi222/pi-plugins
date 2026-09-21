# Agent Note: Snapshot goal state at run boundaries, not per assistant message

Status: implemented

## Problem

`account()` called `checkpoint()` for every assistant message, and it is bound to
`message_end`. A goal whose work run produced fifty assistant messages appended
fifty `goal-state` entries to the session, plus one more per verification
boundary. `restoreGoal` walks `getBranch()` and replays every snapshot it finds,
so the restore path also grew linearly with the goal's length.

The frequency bought nothing. Usage is only enforced at a settled-run or
verifier boundary, so a mid-run snapshot is never read by a decision — it exists
only to narrow a crash window.

## Decision

`account()` accumulates `goal.used` in memory and stops snapshotting.
Persistence stays at the boundaries that already existed: `agent_start`,
`agent_end`, and the verification path. `agent_end` now checkpoints
unconditionally rather than only on the non-aborted branch, so a run that ends
while the goal has already left `active` — a blocker report or a budget stop
during the run — still persists the usage it accrued.

The dedup key moved to the provider's `responseId`, falling back to the
serialized message when the provider does not expose one. This is not a
correctness fix: the byte hash already distinguished distinct messages, because
the serialization includes the timestamp. It is a cheaper identity — no
re-serialization of every message on every `message_end` — and it uses the
provider's own message identity rather than inferring one.

## Alternatives considered

**Throttle by time or count.** A goal that checkpoints every N messages still
writes an unbounded number of entries over a long goal, and it introduces a
crash window whose size depends on message pacing.

**Compact old snapshots.** Rewriting history in a session tree that supports
branch navigation and rewind is not safe, and it would not help the restore
walk.

**Keep per-message snapshots and index them.** The index would have to be
maintained across forks and tree navigation, which is the complexity the
boundary checkpoint avoids entirely.

**Drop the dedup entirely.** `message_end` and `agent_end` both carry the same
assistant message, so without a key the budget would double-count every run.

## Consequences

Session files for long goals grow with the number of runs rather than the number
of messages, and `restoreGoal` walks a correspondingly shorter branch. A crash
mid-run loses the usage accrued since the run started, bounded by one work run —
the same trade the elapsed-time accounting already makes, and documented as
such. The `responseId` path is preferred because it is stable across retries of
the same response; the byte-hash fallback keeps a message with no response id
countable.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::usage is persisted at run boundaries, not per assistant message`
- `plugins/goal/test/lifecycle.test.ts::usage deduplicates event copies and includes verifier before enforcing budget`

Proved: reinstated `checkpoint()` inside `account()`. The run-boundary test
failed with four extra `goal-state` entries after four `message_end` events.
Removing it again returned the suite to green. The dedup test was also run with
the `seen` check removed, which double-counted the replayed assistant message
and reported `used` as 10 instead of 5.
