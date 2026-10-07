# Agent Note: Publish host-compatible subagent state independently of answers

Status: implemented

## Problem

The Paseo pi adapter recognized `agent/task` launches but expected another plugin's `mode/results` details. It ignored our `taskId/status` result and `subagent-result` messages, leaving timed-out children marked running. Answer consumption through show, wait or log also suppresses later result delivery, so answer messages alone cannot serve as UI state updates.

## Decision

`plugins/subagent/src/host-protocol.ts` uses the supported spawn protocol: `subagent_type/prompt`, `agentId` result identity and `subagent-update` custom messages with an `id` and status. Failed maps to error on the host wire; nativeStatus preserves the internal state. Normalize legacy arguments before validation. Publish background state independently on turn settlement, process settlement and replies without starting a parent turn. Keep the executor, task inspection and visible answer delivery unchanged.

## Alternatives considered

- Patch the third-party desktop installation: upgrades would replace it and users would need separate patches.
- Add mode/results only: that adapter lacks a custom completion-message path for these live lanes.
- Use answer notifications alone: reading an answer can consume them before the host learns the final status.

## Consequences

New launches can correlate updates and history replay. Old persisted launches cannot acquire missing identities retroactively. Completion marks a lane answered even while the RPC process stays idle for replies; a reply changes it back to running. The raw RPC evidence path is not advertised as a pi session file. Native failure names and task controls remain stable internally.

## Verification

- `plugins/subagent/test/paseo.test.ts`
- `plugins/subagent/test/plugin.test.ts`
- `plugins/subagent/test/lane-reply.test.ts`
- `plugins/subagent/test/result-delivery.test.ts`

Proved: Before the fix, the Paseo regression failed because required arguments were agent/task instead of subagent_type/prompt. After the fix it verifies a correlated error update even after answer consumption, followed by running on reply and aborted on cancellation. Existing rendering, foreground concurrency and visible answer delivery tests also pass.
