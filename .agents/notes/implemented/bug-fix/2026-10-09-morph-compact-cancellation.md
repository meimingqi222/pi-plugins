# Agent Note: Cancel Morph compaction at the SDK transport

Status: implemented

## Problem

Morph's compaction hook ignored the cancellation signal. An already cancelled
compaction could still send history, and cancelling an in-flight request waited
for SDK completion and could apply a late summary. The SDK timeout only races
the promise and leaves fetch running.

## Decision

Check cancellation before preparing the request. Bind a per-compaction public
MorphAPIClient transport to the caller's signal and a timeout controller, and
inject the resulting signal into every SDK transport request. Check the signal
again after SDK completion; a cancelled hook returns cancel:true rather than
falling through to default compaction. Clear the timer when the operation ends.
Override the CompactClient resource's default timeout with the configured one.

Disable SDK retries for this transport: SDK backoff sleeps cannot be cancelled.
A failed attempt or timeout falls back to pi's compaction, while explicit user
cancellation cancels compaction entirely.

## Alternatives considered

- Promise.race alone: it abandons a promise while the external request continues.
- Pass a signal to CompactClient.compact: the public resource has no such option.
- Patch global fetch: would affect searches and concurrent requests.
- Retain SDK retries: cancellation during a backoff would still wait for sleep.

## Consequences

Cancellation and timeout abort the actual fetch and prevent late summary use.
Compaction now performs one external attempt before fallback; search retries are
unchanged. The SDK still owns request formatting and authentication.

## Verification

- `plugins/morph-search/test/compact-boundary.test.ts`

- `plugins/morph-search/test/compact-boundary.test.ts::Morph compact sends nothing when cancelled before the hook`
- `plugins/morph-search/test/compact-boundary.test.ts::Morph compact aborts the transport during cancellation and discards late summaries`
- `plugins/morph-search/test/compact-boundary.test.ts::Morph compact timeout aborts fetch rather than leaving an external request alive`

Proved: before the fix, the pre-cancel test observed an SDK call, and the
in-flight cancellation test received the late compaction instead of cancel:true.
Both passed after binding the transport signal. A further timeout test confirms
that the actual fetch signal aborts, with one attempt and no network access.
