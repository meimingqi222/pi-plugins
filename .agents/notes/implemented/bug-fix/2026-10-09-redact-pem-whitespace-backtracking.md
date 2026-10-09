# Agent Note: Bound PEM matching

Status: implemented

## Problem

Overlapping whitespace quantifiers stalled synchronous redaction.

## Decision

Require non-whitespace base64 in each body segment, preserving single-line and varied-width bodies.

## Alternatives considered

A 64-column grammar misses compatible keys; an in-process timeout cannot interrupt a regex.

## Consequences

Truncated inputs remain unchanged; complete keys redact. The guard runs in a killable child.

## Verification

- Test file: `plugins/redact/test/pem-backtracking.test.ts`

- `plugins/redact/test/pem-backtracking.test.ts::an unterminated PEM with whitespace finishes in a bounded child`

Proved: The old pattern timed out after 2000ms in the bounded child; both PEM regressions pass after the pattern change.
