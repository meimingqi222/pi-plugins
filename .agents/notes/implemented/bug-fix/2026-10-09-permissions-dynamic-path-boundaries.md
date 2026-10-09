# Agent Note: Resolve HOME and ask on unknown paths

Status: implemented
Partly-superseded-by: 2026-10-09-permissions-yolo-auto-allow.md

## Problem

Quoted HOME and unknown operands became grey and yolo allowed them.

## Decision

Resolve plain HOME expansions through the AST. Ask on unresolved file operands and recursive deletion, including xargs input.

## Alternatives considered

Stripping quotes confuses literals and expansions; assuming unknown paths are safe preserves the bypass.

## Consequences

Home deletion denies, credential reads ask, and known local paths retain their ordinary policy.

## Verification

- Test file: `plugins/permissions/test/security-boundaries.test.ts`

- `plugins/permissions/test/security-boundaries.test.ts::HOME expansion cannot bypass root or credential rules`

Proved: Before the fix quoted HOME deletion was allow; the HOME and unresolved-path tests failed. They pass after the fix.


## Superseded

The classifier/path-boundary decision still holds. The universal dangerous
confirmation requirement, including claims that yolo asks or headless yolo
denies dangerous calls, is replaced by the successor: YOLO allows dangerous
classifications unless an explicit user rule restricts the call. Ask/auto
retain guarded confirmation and forbidden operations remain denied.
