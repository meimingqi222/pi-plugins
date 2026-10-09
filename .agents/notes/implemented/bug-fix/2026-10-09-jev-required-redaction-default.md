# Agent Note: Require active redaction by default

Status: implemented

## Problem

Standalone Jev uploaded message text and tool arguments unredacted by default.

## Decision

Default requireRedact to true; preserve explicit false opt-out and per-request active-v2 checks.

## Alternatives considered

Warnings do not prevent uploads; removing opt-out forbids deliberate standalone use.

## Consequences

Absent or paused redactors use Pi summaries without Jev requests. Unredacted upload requires opt-out.

## Verification

- Test file: `plugins/jev-compact/test/redact-integration.test.ts`

- `plugins/jev-compact/test/redact-integration.test.ts::default upload policy refuses an absent redactor`

Proved: The test observed one request before the default change and zero afterward; opt-out and protected load orders pass.
