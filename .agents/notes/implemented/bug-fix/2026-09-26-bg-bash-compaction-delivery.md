# Agent Note: Delay background completion delivery during idle compaction

Status: implemented

## Problem

Pi reports `isIdle() === false` both for an active agent run and for manual
compaction. The background bash notifier treated every non-idle state before
`agent_end` as a running agent and sent a steer. During compaction that steer
could start a new agent run before compaction finished.

## Decision

Track whether an agent run has started. A completion steers only while such a
run is active. If Pi is non-idle with no active run, retain the bounded notice
batch and retry after 250 ms until Pi is idle or a new run begins. Session
leave cancels the timer and discards the batch. In the post-`agent_end` gap,
explicitly defer delivery to `agent_settled` through the shared queue instead
of passing a constant-false idle probe.

## Alternatives considered

**Send a `nextTurn` message.** It does not wake the agent, so a late failure
could remain unseen.

**Treat any non-idle state as a run.** This was the bug: compaction has no
streaming run to receive a steer.

**Pass a real idle probe to the settled queue.** A completion after Pi's final
queue check must wait for settlement even if a transient probe says idle.

## Consequences

A failure or opted-in completion can be delayed while compaction is busy, but
it is delivered once Pi can accept it. Active runs still receive a short steer;
the post-run gap still waits for `agent_settled`. A permanently busy compaction
keeps one 250 ms retry timer until the session ends.

## Verification

- `plugins/bg-bash/test/plugin.test.ts`
- `plugins/bg-bash/test/plugin.test.ts::completion waits through idle compaction instead of starting an agent run`
- `plugins/bg-bash/test/plugin.test.ts::a completion held during compaction is dropped on session switch`
- `plugins/bg-bash/test/plugin.test.ts::an active agent receives an opted-in completion as a short steer`
- `plugins/bg-bash/test/plugin.test.ts::a completion after agent_end is handed to Pi at agent_settled`

Proved: before the fix, `bun test plugins/bg-bash/test/plugin.test.ts plugins/bg-bash/test/render.test.ts -t 'completion waits through idle compaction|an interrupted record without an end'` failed with `Expected length: 0, Received length: 1` for the compaction test. After the routing change, the focused plugin and renderer tests pass.
