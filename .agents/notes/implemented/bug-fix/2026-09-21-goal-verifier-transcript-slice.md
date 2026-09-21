# Agent Note: Bound the verifier transcript by whole entries, not a byte slice

Status: implemented

## Problem

The verifier transcript was built as `JSON.stringify(entries).slice(-limit)`.
Two failures came out of that one expression.

First, the cut could land anywhere, including inside a serialized entry, so the
verifier was handed a fragment that was not valid JSON — the payload it was
asked to reason about could be structurally broken.

Second, keeping the tail systematically dropped the *earliest* evidence. On a
long goal the earliest entries are what was actually built, and they are the
first thing elided in favour of the most recent narration, which is exactly the
material a completion audit should trust least.

## Decision

`boundedTranscript` walks the filtered branch backwards, serializing one entry
at a time and stopping before the budget would be exceeded. Kept entries are
reversed back to chronological order, so the payload reads forward. The result
reports whether anything was dropped.

The degenerate case — a single newest entry larger than the whole budget — is
clipped rather than dropped, because an empty transcript leaves the verifier
nothing to judge. That is the one place a partial entry is still sent.

The budget itself is unchanged: between 2,000 and 64,000 characters, derived
from the model's context window.

## Alternatives considered

**Slice and then repair.** Trimming back to the last `}` and prepending a `[`
produces something parseable, but it still silently discards the oldest entries
and hides that it did so.

**Keep the tail but mark the cut.** The verifier already receives `truncated`;
marking it does not restore the evidence the cut removed.

**Raise the budget.** The transcript is bounded by the model's context window
for a reason, and the defect was the shape of the cut rather than its size.

**Truncate each entry instead of dropping entries.** Per-entry clipping would
corrupt the newest evidence to preserve the oldest, which is the wrong priority
for an audit that reads forward.

## Consequences

The verifier now always receives whole, parseable entries, and the entries it
loses are the oldest rather than a contiguous tail that mixes both ends. A goal
long enough to elide entries is told so through `truncated`, so a verdict on a
partially visible transcript is not mistaken for one on the full history. The
backwards walk serializes only the entries it keeps, rather than the whole
branch before slicing.

## Verification

- `plugins/goal/test/verifier.test.ts`
- `plugins/goal/test/verifier.test.ts::bounded transcript keeps whole entries and elides the oldest`
- `plugins/goal/test/verifier.test.ts::bounded transcript reports no truncation when everything fits`
- `plugins/goal/test/verifier.test.ts::bounded transcript clips rather than dropping an oversized newest entry`
- `plugins/goal/test/verifier.test.ts::verifier payload keeps whole entries under a tight context window`

Proved: restored the tail slice in `verifyGoal`. The payload test failed — the
transcript split into one line that did not parse, and `entry-0`'s neighbours
survived while the oldest evidence was gone. Restoring `boundedTranscript`
returned the suite to green. An earlier version of these tests called
`boundedTranscript` directly and passed against the sliced call site, which is
why the payload-level test exists.
