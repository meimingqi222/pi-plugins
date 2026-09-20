# Agent Note: Window the conversation, do not shrink it

Status: implemented

## Problem

The engine built **one** Jev state from the whole conversation and shrank it
until it fit `maxStateTokens` (25,000). Every stage of that shrink works by
throwing information away, and the last stage — `old traces dropped` — replaces
each entry's tool calls with `(N tool calls omitted)`.

The result was a state that no longer described the conversation it was asking
about. Measured on a synthetic long session, the state sent to Jev:

```
  400 calls -> state 29,992 tok   "old calls compacted"
  800 calls -> state 15,544 tok   "old calls merged"
 1600 calls -> state    747 tok   "old traces dropped"
```

At 1600 calls the state held **747 tokens** — the whole conversation, its
constraints, its file paths and its tool calls reduced to a few placeholder
lines — while the plugin still asked Jev to decide all 1594 of those calls. The
model was judging calls it could no longer see.

Nothing in the output reported this. `stateStage` said `old traces dropped`, the
compaction succeeded, and a summary was written. The failure was silent: the
plugin looked like it worked and produced decisions with no information behind
them.

This is the normal case, not an edge case. Long conversations are exactly when
compaction runs, and a session with several hundred tool calls is ordinary.

## Decision

Split the conversation into **contiguous windows**, each at most
`maxStateTokens` (raised to 28,000), and judge every tool call inside the window
that contains it. `chunkState` replaces `fitState` as the primary strategy;
`fitState` is kept only as the fallback for a single message larger than an
entire window.

Every window carries:

- the conversation's **first entry**, which holds the standing instruction;
- a few entries of **leading context** from the previous window
  (`DEFAULT_CHUNK_OVERLAP`), so the first call of a window is not judged without
  the turn that explains it;
- its own **body**, which owns the calls to decide.

The overlap is **reserved during packing**, not dropped on overflow. A full
window is the normal case for a long conversation, so dropping overlap first
would mean it never applied when it was needed.

Same session, after:

```
  400 calls -> 2 windows, ~28k each, stage "full"
  800 calls -> 3 windows, ~28k each, stage "full"
 1600 calls -> 5 windows, ~28k each, stage "full"
```

All 1594 calls are still decided, and each is decided with its own context
intact rather than a placeholder.

### The preamble had to be capped

Windowing introduced its own failure, caught by replaying the real session: the
first entry is repeated as the preamble in **every** window, and on a second
compaction that entry is `previousSummary` — 823,033 chars of pure text, about
200k tokens. An uncapped preamble exceeded the whole window budget, so no second
entry could ever fit and the packer emitted **318 windows for 318 messages** at
14% budget utilisation, i.e. one request per message.

The preamble is now capped to a quarter of the window budget and abridged to its
head and tail (the head usually names the task). The same session produces 5
windows at 100% utilisation. Any other entry too large to share a body with the
preamble is shrunk before packing for the same reason.

Two supporting changes came with it:

- **`maxRequestTokens` 30,000 → 64,000.** Jev's documented budget is 64k for
  `state` + all questions combined; 30k was half of it and forced 9 requests
  where 2 suffice, each re-sending the whole state. Measured on a real session:
  269k billed input tokens instead of 94k for identical decisions.
- **`estimateTokens` charged 0.9 per CJK character.** Measured against Jev's
  reported `input_tokens`, Chinese costs ~1.18/char — a 17% shortfall, 33% on
  mixed Chinese/identifier text. Underestimating is the dangerous direction,
  because the ceiling is enforced against *this* number: a window believed to be
  under the limit could be rejected outright. CJK now costs 1.2/char, and the
  window default is 28k rather than 32k to leave ~12% headroom for the residual
  error on English prose (measured 1.10).

## Alternatives considered

**Raise `maxStateTokens` so the whole conversation fits.** Rejected: the state
grows ~69 tokens per call even after shrinking, so 1600 calls need ~110k against
a hard API ceiling of ~32k (measured: 32,343 accepted, 32,812 rejected). No
budget can fit an arbitrarily long conversation.

**Keep the whole-history shrink and just add a "state is too small" warning.**
Rejected as insufficient. It would report the problem without fixing it, and the
compaction would still write a summary built on blind decisions.

**Cut the conversation into windows and let each window decide only the calls in
its body, with no overlap.** Simpler. Rejected because the first call of each
window would be judged with no preceding turn, which is precisely the context
that explains it. The overlap costs a few entries per window and is reserved, so
it survives a full window.

**Chunk by a fixed message count instead of a token budget.** Rejected: entries
vary by orders of magnitude (a one-line assistant message next to a 2000-char
tool trace), so a count-based split would either overflow the ceiling or waste
most of it.

## Consequences

A long conversation now compacts with full context instead of a placeholder
state. Cost is bounded: more windows means more requests, but each is smaller
than the single oversized one it replaces, and `maxRequestTokens: 64_000` keeps
the per-window question count low.

`CompactStats` gains `chunks`. A large `chunks` with `stateStage: "full"` is the
healthy case; `stateStage` reaching `old traces dropped` now means a single
window overflowed, not the whole conversation.

The chunking is only as good as the estimator's accuracy: a systematic
underestimate would push windows over Jev's real ceiling. That is why the CJK
charge and the 28k default carry the measured ratios in their comments.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::a history too big for one window is split into several`
- `plugins/jev-compact/test/engine.test.ts::every window keeps full detail instead of degrading to a trace dump`
- `plugins/jev-compact/test/engine.test.ts::the standing first message reaches every window`
- `plugins/jev-compact/test/engine.test.ts::every call a window owns is present in that window's state`
- `plugins/jev-compact/test/engine.test.ts::an oversized first message does not give every entry its own window`
- `plugins/jev-compact/test/engine.test.ts::a huge preamble is abridged, keeping its head`
- `plugins/jev-compact/test/engine.test.ts::a window carries context from the window before it`
- `plugins/jev-compact/test/engine.test.ts::compaction across windows decides every call and reports the count`
- `plugins/jev-compact/test/engine.test.ts::CJK text is not underestimated`
- `plugins/jev-compact/test/engine.test.ts::a cancellation signal is handed to every request`

Proved: reverting `compact()` to the single whole-history `fitState` failed
`compaction across windows decides every call and reports the count` (a
single-chunk state cannot report `chunks > 1`); removing the CJK branch from
`estimateTokens` failed `CJK text is not underestimated`. Both were restored and
re-ran green (92 pass, 0 fail).

The invariant test `every call a window owns is present in that window's state`
was written after the first version of `chunkState` failed it: the
overlap-dropping loop spliced at a fixed index and walked backwards into the
body, deleting entries that owned calls — the same class of bug the refactor
removes. It is asserted directly because a window deciding a call it cannot see
is the exact failure being fixed.

Removing the preamble cap and the per-entry pre-shrink failed
`an oversized first message does not give every entry its own window` (318
windows instead of a handful). Restored and re-ran green (94 pass, 0 fail).

Verified end to end against the recorded session: the real 353-call slice now
produces 5 windows at ~28k each with `stateStage: "full"`, where the old code
produced one 29,974-token state at `old calls compacted`. The second-compaction
slice (previousSummary-dominated) went from 318 windows to 5, with every one of
its 281 candidate calls still owned by exactly one window.
