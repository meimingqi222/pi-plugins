# Agent Note: Read-only enforcement precedes confirmation

Status: implemented

## Problem

Dangerous classification returned ask before the read-only mode table ran.
Allow once therefore released force push in read-only mode. The internal-error
fallback independently offered the same override.

## Decision

Reject non-safe or mutating calls in read-only before the dangerous confirmation
branch. Keep forbidden and explicit deny rules first. Never offer an internal
error override in read-only; safe non-mutating calls remain available.

## Alternatives considered

- Hide Allow once in the prompt: leaves the decision API incorrectly returning
  ask and does not cover headless consumers or the error fallback.
- Tighten YOLO: unrelated to the read-only bug and contradicts its authorized
  automatic execution contract.

## Consequences

Read-only is an enforcement boundary. Confirmation cannot lift it. Ask/auto
continue to confirm dangerous calls; YOLO remains automatic except forbidden
and explicit restrictions.

## Verification

Test file: `plugins/permissions/test/plugin.test.ts`.

- `plugins/permissions/test/plugin.test.ts::read-only rejects dangerous calls and internal errors without approval`

Proved: before the fix this new test failed because force push returned
undefined after Allow once instead of block. The pre-fix wiring suite had
27 pass / 10 fail. After the fix the test passes, including npm publish,
throwing input getters, zero dialogs and successful git status.

Final verification: `bun run typecheck`, `bun run test` (1461 pass / 0 fail across 13 packages), and `bun run notes` passed.
