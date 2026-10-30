# Agent Note: Redact structured tool results and invisible-character matches

Status: implemented

## Problem

The tool result patch could remove structuredContent and missed secrets present only there. Format characters could split a secret before regex matching.

## Decision

Scan structuredContent and preserve its redacted value with any content patch. Match format-normalized text while mapping redaction spans back to original text.

## Alternatives considered

Dropping structured content breaks consumers; removing format characters globally damages unrelated human text.

## Consequences

Both forms are scanned; unrelated text retains its format characters. Unicode Tags retain their pre-existing sanitization.

## Verification

- `plugins/redact/test/index.test.ts::redacts and preserves structured tool results` and `plugins/redact/test/engine.regression.test.ts::redacts secrets separated by format characters without changing surrounding text`

Proved: the pre-fix assertion failed; output saved to `regression-evidence/redact-structured-red.txt` and `regression-evidence/redact-invisible-red.txt`.
