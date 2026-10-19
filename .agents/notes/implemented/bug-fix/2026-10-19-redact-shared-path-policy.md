# Agent Note: Apply configured paths at the shared redaction boundary

Status: implemented

## Problem

Configured redactPaths were only applied to tool-result details. The provider
hook and published service used the same redactor but never called its path
operation, so opaque values selected by configuration were left unchanged.

## Decision

The shared redactValue function in `plugins/redact/src/index.ts` applies both
pattern scanning and path redaction. All hook and service consumers inherit the
same policy. The old details-only path pass is removed rather than duplicated.

## Alternatives considered

**Add another provider-only path pass.** Leaves the service inconsistent and
makes future consumers remember to compose both operations themselves.

## Consequences

Paths are relative to the actual JSON value supplied to the hook or service.
They do not parse embedded textual JSON or match arbitrary descendant fields.
Copy-on-write leaves the caller's original value intact. Pause and consumer
error propagation retain their existing semantics.

## Verification

- `plugins/redact/test/index.test.ts::configured paths apply`

Proved: the test added before the fix observed no censored provider field,
failing its boolean assertion. Output is saved in
`.agents/notes-evidence/2026-10-19-redact-boundaries-red.txt`. After composing
the shared policy, both provider and service assertions pass and the original
object stays unchanged.
