# Agent Note: Redact Morph compaction at its external request boundary

Status: implemented

## Problem

The optional Morph compaction hook sends session history directly through the
Morph SDK. Pi's provider redaction hook does not cover that transport, and raw
user messages, turn prefixes and previous summaries can therefore leave the
machine with secrets even when pi-redact is enabled.

## Decision

Discover pi-redact's version 1 or 2 service through the shared event bus, both by
subscribing and by requesting an announcement. Redact the complete messages
array, including the previous summary, immediately before invoking compaction.
A throwing discovered service causes the hook to fall back to pi's default
compaction without sending the raw payload. Keep standalone behavior when the
redaction plugin is absent; the service itself owns its pause policy.

## Alternatives considered

- Import pi-redact directly: independently published plugins must not acquire a
  runtime dependency just to negotiate an optional service.
- Trust provider hooks: the SDK request bypasses those hooks.
- Catch a redactor failure and send raw history: recreates the privacy gap.

## Consequences

Both plugin load orders work. Morph receives redacted history when a compatible
service is present; users without pi-redact retain standalone compaction.

## Verification

- `plugins/morph-search/test/compact-boundary.test.ts`

- `plugins/morph-search/test/compact-boundary.test.ts::Morph compact redacts history, prefix and previous summary in either plugin load order`
- `plugins/morph-search/test/compact-boundary.test.ts::Morph compact fails closed when a discovered redactor throws`

Proved: before adding the bridge both tests failed: the captured request still
contained the fixture, and a throwing redactor still produced an unsafe summary.
The same tests pass after the fix, with no external network requests. The
combined four-fix red run recorded 16 pass / 7 fail.
