# Agent Note: A per-call note becomes an inherited category

Status: implemented

## Problem

A `drop_call` replaced the tool output with a separate serialized part:

```
[Assistant tool calls]: read(path="src/config/defaults.ts")

[Tool result]: (output discarded by compaction; re-run `read` if needed)
```

The note is **text**, and the engine never deletes text. So every later
compaction copied all previous notes forward at full size, and added its own.
Measured across a real session's compactions:

```
条目 1302  notes 354   (dropped this pass 354, inherited   0)
条目 1887  notes 167   (dropped this pass 167, inherited   0)
条目 2142  notes 259   (dropped this pass  93, inherited 166)
条目 2260  notes 330   (dropped this pass  75, inherited 255)
```

By the fourth compaction, 77% of the notes were inherited. They were 11.4% of a
224 KB summary (25,377 chars), and the count grows without bound: projecting the
observed ~75 new drops per pass, the notes reach 35% of the summary after 10 more
compactions and 59% after 20.

The note also duplicated the call line's identity. It repeated the tool name
(`re-run \`bash\``) that the call line had already stated, and cost a whole extra
part per call.

## Decision

Two changes, both in `src/serialize.ts`:

**1. Mark the discard on the call's own line, and emit no result part.**

```ts
const DISCARDED_MARKER = ' [output discarded; re-run to restore]';
...
parts.push(tool.removed ? `${line}${DISCARDED_MARKER}` : line);
if (tool.removed) continue;   // no [Tool result]: part
```

The marker rides on a line that has to exist anyway, so it adds no new category
to inherit. Dropping the tool name from the note is safe because the call line
already names the tool — measured, the marker is one string for every tool, not
four.

Omitting the `[Tool result]:` part is the **signal**, not an omission: a call
followed by a result still has its output, a marked call does not. A note there
would read like an output that happens to be short.

**2. Repair notes inherited from earlier versions at fold-in time.**

New notes stop growing, but the 328 already accumulated are inside
`previousSummary`, which is copied verbatim. `normalizeDiscardedNotes()` rewrites
them into the inline marker while folding it back in. It is deliberately strict —
it rewrites only a part **equal** to the old note, immediately after a call line
naming the **same** tool. A kept result whose text merely contains the phrase is
not such a part, and a note that does not follow its own call cannot be safely
merged. The transformation is lossless (the tool name the note repeated is
already on the call line) and idempotent (the marker is not the note).

Measured on the real summary: 328 notes → 0, 328 inline markers, 224,214 →
212,402 chars (−5.27%), idempotent, call-line count unchanged at 360.

## Alternatives considered

**Merge runs of discarded calls into `(N calls omitted)`.** Measured and
rejected. Consecutive dropped calls average **1.34** in length (244 runs for 326
calls, longest 6), so aggregation produced *fewer* savings than inlining
(−3,566 chars relative to it) while discarding the per-call marker that
distinguishes "discarded" from "produced nothing".

**Keep the two-part note and rely on Jev to drop it.** Jev cannot: the engine
never deletes text, by design. That guarantee is the plugin's whole advantage, so
a text category is permanent by construction.

**Strip notes with a global regex over the summary.** Rejected. `[Tool result]:`
parts can contain arbitrary tool output, and a global replace would rewrite text
inside a kept result. Matching exact parts with a verified preceding call keeps
the rewrite confined to notes this extension actually emitted.

**Delete the notes outright.** Rejected: the note is what tells the model the
output is re-obtainable. Removing it entirely would leave a bare call line, which
reads like a call whose output was empty.

## Consequences

- New discard markers add no inheritable category: the marker is part of a line
  that already existed, and it is one string rather than one per tool.
- Accumulated notes are repaired on the next compaction rather than copied
  forward.
- `discardedTraceNote(tool)` is gone; `droppedCallChars(input)` no longer takes
  the tool name, because the marker does not depend on it.
- The size accounting still measures exactly what is rendered, so the
  "dropping must not grow the transcript" guard now compares against a 37-char
  marker instead of a ~72-char note, and therefore discards slightly more often.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts` and
`plugins/jev-compact/test/hook.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::a discarded call emits one line, and no result part`
- `plugins/jev-compact/test/engine.test.ts::a discarded call never occupies a second part`
- `plugins/jev-compact/test/engine.test.ts::the marker names no tool, because the call line already does`
- `plugins/jev-compact/test/engine.test.ts::a kept call still emits its result part`
- `plugins/jev-compact/test/engine.test.ts::a legacy note merges into its own call line`
- `plugins/jev-compact/test/engine.test.ts::a note whose tool disagrees with the preceding call is left alone`
- `plugins/jev-compact/test/engine.test.ts::a note with no call line before it is left alone`
- `plugins/jev-compact/test/engine.test.ts::quoted text that merely contains the phrase is not rewritten`
- `plugins/jev-compact/test/engine.test.ts::normalizing is idempotent and never rewrites a marker twice`
- `plugins/jev-compact/test/engine.test.ts::a call line pushed to a new part by a trailing newline still merges`
- `plugins/jev-compact/test/hook.test.ts::discard notes inherited from an earlier version are folded in`

Proved: reverting the renderer to the two-part note failed five tests
(`a discarded call emits one line, and no result part`, `a discarded call never
occupies a second part`, `the marker names no tool…`, `no result outlives its
call, and the trace is labelled in the output`, `no decision can grow the
transcript`). Removing the `normalizeDiscardedNotes` call from the hook failed
`discard notes inherited from an earlier version are folded in`. Restoring
`part.trimStart()` to a start-anchored match — the bug the real summary exposed,
where two call lines sat after a part ending in a newline — failed `a call line
pushed to a new part by a trailing newline still merges`. Each red run returned
the suite to 112 pass, 0 fail when reverted.
