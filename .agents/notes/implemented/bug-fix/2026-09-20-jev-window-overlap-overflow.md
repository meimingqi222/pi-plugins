# Agent Note: Cap the window overlap so the first body entry always fits

Status: implemented

## Problem

`chunkState` split a long conversation into windows of at most
`maxStateTokens`, but the packer could emit a window it had no way to shrink,
and it then threw. The caller (`compact`) catches that error and falls back to
`fitState` — the single whole-history shrink the windowing design exists to
replace — so the failure was **silent**: `stats.chunks` reported `1`, the
compaction succeeded, and Jev judged every call from a mutilated state. This is
exactly the `jev-whole-history-shrink-blinds-model` failure, restored.

The packer reserved overlap by summing every entry in `[start - overlap, start)`
into `used` before adding any body entry, then entered the body loop:

```js
let end = start;
while (end < entries.length) {
  if (end > start && used + tokens[end]! > budget) break;
  ...
}
```

The guard is `end > start`, so the window **always** swallows its first body
entry regardless of `used`. When the preamble plus a full overlap of 3 had
already spent the budget, the built window went over. The in-place shrinker then
could not repair it:

```js
for (const entry of history) {
  stages.push(shrinkEntryToFit(entry, Math.max(1, budget - base), original));
}
```

`shrinkEntryToFit` returns early when `entryTokens(entry) <= budget`, and the
argument here is `budget - base` — which every ordinary body entry satisfies on
its own. So **no entry shrank**, `total > budget` still held, and the window hit
the throw.

Measured on five pasted source files of ~6k tokens each plus one tool call, the
default configuration:

```
overlap=0: ok, 2 chunks
overlap=1: ok, 2 chunks
overlap=2: ok, 2 chunks
overlap=3: THREW one message is larger than a Jev window (~30,256 tokens, limit 28,000)
overlap=4: THREW
```

The trigger is a run of **medium** messages — each roughly 5k–8k tokens, i.e. a
pasted document or a long assistant reply — which is ordinary. The size matrix
before the fix (`maxStateTokens` 28,000, default overlap 3):

| tokens/message | n=3 | n=4 | n=5 | n=6 | n=8 | n=10 |
| --- | --- | --- | --- | --- | --- | --- |
| ~4,000 | ok | ok | ok | ok | ok | ok |
| ~5,000 | ok | ok | ok | ok | ok | ok |
| ~6,000 | ok | ok | **threw** | **threw** | **threw** | **threw** |
| ~7,000 | ok | ok | **threw** | **threw** | **threw** | **threw** |
| ~8,000 | ok | ok | **threw** | **threw** | **threw** | **threw** |

Existing coverage missed it from both sides: `transcript(400)` entries are tiny,
so nothing ever competed for the budget, while the oversized-first-message tests
covered only the other extreme (a huge preamble). The middle of the range had no
case.

## Decision

Reserve the overlap **subject to the first body entry fitting**. For each window,
the overlap budget is

```
max(0, budget - base - preambleTokens - tokens[start])
```

Overlap entries are then taken from the newest backwards (the context closest to
the body is the most relevant), skipping any that do not fit, until the overlap
count or that budget is reached. The packer records the positions it actually
reserved on the range, and the window builder reproduces exactly those, so the
built window matches the size the packer planned for rather than recomputing it.

This preserves the original intent — overlap is *reserved*, never dropped on
overflow, so a full window still carries its leading context — while giving the
window's own first body entry priority over optional preamble entries. Overlap
is context around a decision; the body entry is the thing being decided, and
running a Jev request whose only purpose is to shrink optional context is the
wrong trade.

With the fix, every cell in the table above produces windows within budget:

| tokens/message | n=3 | n=4 | n=5 | n=6 | n=8 | n=10 |
| --- | --- | --- | --- | --- | --- | --- |
| ~6,000 | 1 | 1 | 2 | 3 | 5 | 7 |
| ~7,000 | 1 | 1 | 2 | 3 | 5 | 7 |
| ~8,000 | 1 | 1 | 2 | 3 | 5 | 7 |

## Alternatives considered

**Cap only the preamble, harder.** The preamble is already capped at a quarter of
the budget. Tightening that cap fixes this instance but not the mechanism: any
combination of a moderately large preamble, a full overlap and a moderately large
first body entry reproduces it. The bug is that the body entry was never charged
against the reservation, so the reservation must account for it.

**Drop the oldest overlap entries on overflow (the original comment's rejected
option).** This is what "dropping overlap first" means, and it was rejected when
windowing was introduced because a full window is the normal case — overlap would
then never apply exactly when it was needed. Taking overlap newest-first within a
reduced budget keeps overlap in the common case and only shortens it when the
body entry leaves no room, which is the opposite of the old behavior.

**Let the in-place shrinker target the overlap and preamble entries.** The
shrinker's argument (`budget - base`) is a whole-window budget applied per entry,
so it is a no-op for entries that already fit individually. Making it aware of
which entries are optional requires the packer to know the same thing, i.e. the
same computation as the fix, but performed later and after the window is already
over budget. Reserving correctly up front is simpler and leaves the shrinker as
the last-resort path it was documented to be.

**Throw and rely on `fitState`, documenting it as acceptable.** The fallback is
what made this silent: compaction keeps succeeding, `chunks` reports 1, and no
notice distinguishes "windowed" from "one shrunken history". If the fallback is
acceptable there is no reason to window at all.

## Consequences

A window's overlap can now be shorter than `DEFAULT_CHUNK_OVERLAP` when its
first body entry is large; it is never longer. The `overlap` positions are
carried on the internal range record and the builder no longer recomputes them
from `range.start`, so the packer and the builder cannot disagree about what
was reserved — the same class of drift the serializer note guards against.

2000 randomized transcripts (message sizes 0–30k chars, 0–40 entries, mix of
text and tool calls) produced zero throws, zero windows over budget, zero
duplicate call ownership, and zero calls decided in a window that did not contain
them.

`fitState` remains the fallback for a genuinely unshrinkable single entry, which
is the only case the throw was ever meant for.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::a run of medium messages does not overflow a window`
- `plugins/jev-compact/test/engine.test.ts::a window carries context from the window before it`
- `plugins/jev-compact/test/engine.test.ts::every call a window owns is present in that window's state`
- `plugins/jev-compact/test/engine.test.ts::a history too big for one window is split into several`

Proved: reverting the reservation to sum the whole overlap before adding body
entries → `plugins/jev-compact/test/engine.test.ts::a run of medium messages does
not overflow a window` failed with `one message is larger than a Jev window
(~29,668 tokens, limit 28,000)`, then restored and re-ran green (116 pass, 0
fail).
