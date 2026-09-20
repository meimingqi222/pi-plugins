# Agent Note: A long conversation must shrink, not throw

Status: implemented

## Problem

`fitState` shrinks the state sent to Jev through a fixed series of stages: clip
tool inputs, abridge long texts, collapse old messages, compact old calls, omit
call-less messages, merge adjacent call runs. All but the last work *within* an
entry, so they leave a floor proportional to the number of tool calls —
measured at roughly **69 tokens per call**. Past a certain call count, no
per-entry truncation can reach the budget, and the function threw:

```
history too large for Jev (~26717 tokens after truncation, limit 25000)
```

A throw is not a degraded compaction. `compact()` rejects, the
`session_before_compact` handler catches, and the plugin returns `undefined`,
so pi falls back to its own summary. The whole point of the plugin is skipped.

Two pieces of evidence show this was close, not theoretical:

**The real session passed by 21 tokens.** The recorded stats from the one
production compaction this plugin has run:

```
stateTokens   24,979
maxStateTokens 25,000     ← 21 tokens of headroom
stateStage    "old messages left out"   ← the second-to-last stage
```

Replaying the identical slice reproduces it: 24988 tokens at
`"old messages left out"`. The next stage (`mergeCallRuns`) was the last one
available; a slightly larger conversation would have failed outright.

**The floor scales linearly.** Fitting the same transcript at increasing sizes
(pinned tail excluded, so these are real candidate counts):

```
  30 msgs /  15 calls ->  ~5,422 tok
 100 msgs /  53 calls -> ~19,426 tok
 200 msgs / 109 calls -> ~43,352 tok
 311 msgs / 173 calls -> ~65,402 tok
```

At the observed rate, 360 candidate calls need ~25k — exactly the default. A
400-call session needs ~28k and throws.

Raising `maxStateTokens` cannot be the answer on its own: Jev's own request
ceiling is finite, and it is not large. Measured against the live API with a
filler payload:

```
 30,000 tokens: HTTP 200
 31,875 tokens: HTTP 200
 32,343 tokens: HTTP 200
 32,812 tokens: HTTP 400  {"error_type":"max_tokens_exceeded"}
```

So the ceiling is ~32.7k. A 6,000-call conversation would need ~414k of state and
no budget could fit it.

## Decision

A final stage drops **whole call traces**, oldest first, replacing each entry's
`tool_calls` with `"(N tool calls omitted)"`. Every text entry is left untouched.

This is the right shape for three reasons:

- It removes the floor. The remaining cost is one short string per call-run, so
  the stage can reach any budget regardless of call count.
- It preserves the property that matters. Text carries constraints and
  decisions; traces are only a pointer to re-runnable output. Lost traces are
  the acceptable casualty, and the stage takes them oldest-first so recent calls
  — the ones most likely still relevant — are dropped last.
- An entry that had calls keeps a marker, so Jev still knows a call happened
  there rather than seeing a message that appears never to have run anything.

The stage runs after `mergeCallRuns`, so it only engages when everything cheaper
has failed.

`JEV_COMPACT_MIN_REDUCTION` was also raised, from `0.1` to `0.3`, based on the
same session. The measured input was **86.4% `previousSummary`** — pure text,
which Jev never deletes — so the maximum achievable reduction was 2.8%: dropping
every tool output still barely moved the total. At a 0.3 threshold that case
defers to pi, which rewrites the entire summary and genuinely shrinks it, instead
of replacing a structured summary with a near-identical verbatim transcript.
`0.3` still keeps Jev for the case it wins: a session whose bulk is fresh tool
output.

## Alternatives considered

**Raise `maxStateTokens` to the observed ceiling (~32k).** One-line change, and
it would have carried the 360-call session. Rejected because it only moves the
cliff: the floor grows ~69 tokens per call, so 400 calls need ~28k and 500 need
~35k, past the API ceiling. It trades a fixable failure for a later, harder one.

**Drop the oldest messages entirely, not just their traces.** Frees more per
step. Rejected because it deletes conversation text, which is the one thing this
plugin promises never to lose. Dropping traces keeps that promise intact.

**Rather than throwing when a stage fails, return the best fitted state.** Would
avoid the fallback. Rejected because it would silently exceed the API's token
ceiling and produce a `max_tokens_exceeded` error instead — a request that fails
later and less legibly than a clear local error.

**Truncate `previousSummary` before folding it in.** Addresses the 86% case
directly. Rejected as a separate change: it discards history the plugin was just
fixed to preserve, and the threshold handles the same case without losing
anything.

## Consequences

A very long conversation now compacts instead of falling back, at the cost of
losing the oldest tool-call pointers. The summary remains a complete record of
what was said and decided.

`stats.stateStage` gains `"old traces dropped"`, which is worth watching: it
means the conversation outgrew every cheaper stage and the oldest traces were
sacrificed. It appears in `details.stats` on the compaction entry.

The `MIN_REDUCTION` change means a second compaction whose input is dominated by
a prior summary will defer to pi. That is a deliberate trade of "Jev's better
fidelity" for "pi's better compression" in exactly the case where Jev has almost
nothing to delete — but it does mean fewer compactions will use this plugin on
long-running sessions.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::a history with more calls than the budget can fit still fits`
- `plugins/jev-compact/test/engine.test.ts::dropping traces keeps every text entry`

Proved: removed the fallback stage → both tests failed (`fitState` threw
`history too large for Jev` on an 800-call transcript at a 12k budget), then
restored and re-ran green (83 pass, 0 fail). The first version of these tests
used 400 calls and **did not fail** on the red run — the synthetic fixture
compresses better than the real session — so the count was raised until the red
run genuinely failed. Verified against the live API that the stage is reachable
and sufficient: the real 387-call slice that previously threw now fits at 24,973
tokens via `"old traces dropped"`.
