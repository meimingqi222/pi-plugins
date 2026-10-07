# Agent Note: RPC system prompts survive child startup

Status: implemented

## Problem

The RPC spawner returned a live handle inside a try/finally. The finally
removed the delegated system prompt before the child had loaded it. Pi treats
a missing prompt path as literal prompt text, so the delegated instructions
could silently disappear.

## Decision

Keep the private prompt file until the child run finishes. Finish waits for
both evidence flushing and prompt cleanup before resolving done. A synchronous
spawn failure cleans the file before propagating the error.

## Alternatives considered

- Delay deletion by a fixed timer: startup time varies and a delay cannot prove
  that the child has read the file.
- Delete on the first stdout event: that would add a protocol assumption about
  resource loading and needs a separate failure cleanup path.

## Consequences

The file lives as long as the bounded RPC process, including its idle keepalive.
The JSON transport and the child environment are unchanged.

## Verification

- `plugins/agent-runner/test/rpc-child.test.ts::the RPC system prompt survives startup and is removed after done`
- `plugins/agent-runner/test/rpc-child.test.ts::a synchronous RPC spawn failure cleans the system prompt`

Proved: before the fix, the startup test received "missing" instead of the
delegated instructions. The red run is saved in
`.agents/notes-evidence/2026-10-07-subagent-lifecycle-red.txt`. After the fix,
both prompt lifecycle tests pass; the focused two-file suite has 42 pass,
1 skip, and 0 fail.
