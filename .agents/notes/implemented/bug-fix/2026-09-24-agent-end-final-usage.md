# Agent Note: Count a final assistant reply from agent_end

Status: implemented

## Problem

The shared child runner ignored the entire `agent_end.messages` list after it
had seen any `message_end`. If the final assistant reply appeared only in
`agent_end`, the runner returned an earlier answer and under-reported usage.

## Decision

Count assistant `message_end` events, then process only the remaining assistant
messages in the terminal transcript. This preserves the replay deduplication and
includes a final reply that lacks its own event.

## Alternatives considered

Always replaying all `agent_end` messages would double-charge every ordinary
response. Ignoring `agent_end` keeps the observed undercount.

## Consequences

The runner now uses transcript order to identify the already delivered prefix.
The child process test covers both the final text and the sum of both replies.

## Verification

- `plugins/agent-runner/test/executor.test.ts` — test "counts a final assistant reply present only in agent_end".

Proved: before the runner fix, the test failed with `Expected: "final reply"`,
`Received: "first reply"`; after the fix it passed.
