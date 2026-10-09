# Agent Note: Identify Paseo before special notifications

Status: implemented

## Problem

Background RPC lanes emitted Paseo-specific magic text to generic clients.

## Decision

Require PI_RPC_CLIENT=paseo for special notifications; preserve ordinary RPC updates.

## Alternatives considered

RPC mode alone is not identity; deleting the notification breaks the Paseo adapter.

## Consequences

Paseo opts in through parent environment; generic clients receive no magic text.

## Verification

- Test file: `plugins/subagent/test/host-progress.test.ts`

- `plugins/subagent/test/host-progress.test.ts::Paseo notifications require an explicit RPC client opt-in`

Proved: The generic client received one magic notification before the fix; afterward only the opted-in client receives it.
