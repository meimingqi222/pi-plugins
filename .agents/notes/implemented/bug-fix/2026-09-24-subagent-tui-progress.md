# Agent Note: Show subagent identity and live activity in the TUI

Status: implemented

## Problem

The `subagent` extension registered only an executor. Pi therefore displayed a
generic `subagent` card while the child ran. The user could not see which named
agent was selected or whether it was using tools.

## Decision

Render the selected agent and task on the call card. Forward only Pi child tool
start and end events through the shared runner, then use `onUpdate` to display
the current tool, its file path when available, and completed count. Keep five
recent activities in bounded details for the expanded card. Render a concise
final status and reply preview;
the full reply stays in the result details. Search patterns, command contents
and outputs do not enter the progress channel.

## Alternatives considered

Streaming the child's full JSON transcript into the parent card would expose
tool arguments, grow without bound and duplicate the final answer. A timer-only
spinner would show that time passed without telling the user what the child did.

## Consequences

The TUI now identifies the child before it starts and shows activity as Pi emits
tool events. Long model reasoning without tool calls remains labelled as working.
The optional runner callback leaves workflow behaviour unchanged.

## Verification

- `plugins/subagent/test/plugin.test.ts` — test "shows the selected agent, task and live tool activity".
- `plugins/agent-runner/test/executor.test.ts` — test "forwards child tool activity with a bounded path but no search pattern or output".

Proved: temporarily disabled progress forwarding in `executeSubagent`; the
subagent test failed with `Expected: > 1, Received: 1` updates. Restored the
forwarding and both bound tests passed.
