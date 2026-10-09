# Agent Note: Check all grep-family credential searches

Status: implemented
Partly-superseded-by: 2026-10-09-permissions-yolo-auto-allow.md

## Problem

Only grep checked broad credential search roots.

## Decision

Use normalized executable names and apply the credential-root policy to grep, rg, egrep and fgrep.

## Alternatives considered

Raw executable matching misses absolute paths; treating all searches as dangerous blocks workspace search.

## Consequences

Credential roots ask in yolo; workspace searches remain allowed.

## Verification

- Test file: `plugins/permissions/test/security-boundaries.test.ts`

- `plugins/permissions/test/security-boundaries.test.ts::all grep-family tools ask before searching credential roots`

Proved: The old rg result was safe/allow and the family test failed; all variants pass after the change.


## Superseded

The classifier/path-boundary decision still holds. The universal dangerous
confirmation requirement, including claims that yolo asks or headless yolo
denies dangerous calls, is replaced by the successor: YOLO allows dangerous
classifications unless an explicit user rule restricts the call. Ask/auto
retain guarded confirmation and forbidden operations remain denied.
