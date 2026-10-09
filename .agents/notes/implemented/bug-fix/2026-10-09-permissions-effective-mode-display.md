# Agent Note: Display and inherit the effective permission mode

Status: implemented

## Problem

With PI_PERMISSIONS_MODE=ask, mode yolo reported and displayed yolo while tools
still enforced ask. Parent inheritance was only updated by a later tool call,
so children spawned immediately after a mode command could receive stale mode.

## Decision

Resolve mode and its source once for enforcement, status and notifications.
Mode commands preserve the requested session setting but display its effective
value and explain overrides. Publish effective mode on start, command changes,
status/reload and tool decisions. Report saved globally only after successful
persistence.

## Alternatives considered

- Make session commands override environment: changes documented precedence.
- Correct only the status line: leaves notifications and inherited mode stale.

## Consequences

Requested values cannot masquerade as effective values. Removing an environment
override reveals the requested session mode. Children continue to prioritize
inherited mode over their own environment and config.

## Verification

Test file: `plugins/permissions/test/plugin.test.ts`.

- `plugins/permissions/test/plugin.test.ts::mode command displays effective mode and override source`

Proved: before the fix the new test failed with perm: yolo instead of perm: ask.
After the fix it passes and checks the override source, immediate inherited ask,
and effective session yolo after the environment override is removed.

Final verification: `bun run typecheck`, `bun run test` (1461 pass / 0 fail across 13 packages), and `bun run notes` passed.
