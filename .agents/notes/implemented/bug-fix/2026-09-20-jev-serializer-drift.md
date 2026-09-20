# Agent Note: Measure the string you actually emit

Status: implemented

## Problem

The reduction ratio decides whether a Jev compaction is used at all
(`JEV_COMPACT_MIN_REDUCTION`, default 0.3) and is what the user sees in the
notification. It was computed from `messageChars()`, a hand-written model of the
serializer, while the serializer itself lived in `src/pi-adapter.ts`. Two modules
that had to agree, with nothing enforcing it.

They had drifted. `messageChars` counted:

- `message.text.length` — the renderer emits `[User]: ` / `[Assistant]: ` first
- `JSON.stringify(input).length` for a kept call — the renderer emits `key=value`
- nothing for the `[Tool result]: (output discarded…)` note a dropped call emits
- nothing for the `\n\n` separators between parts

Measured by replaying the recorded decisions from a real session:

```
              reported      actual      error
charsBefore    456,765     466,810      -2.2%
charsAfter      87,391     107,689     -23.2%
ratio           80.87%      76.93%    +3.94 points
```

On the stored compaction the notification said 78.42% where the truth was
73.78%. A 4-point overstatement is enough to flip a decision near the 0.3
threshold: a session with 27% of its bytes removable would be reported as 31% and
handed to Jev, which then swaps pi's rewritten summary for a near-identical
verbatim transcript — the exact trade the threshold exists to prevent.

This is a recurrence of `jev-reduction-accounting`, which fixed one instance of
the same class (a removed call's full input being counted instead of its clipped
trace). That fix shared `renderTraceArgs` between the two modules but left the
framing unmodelled, so the drift returned in a different place.

## Decision

Move the renderer and the measurement into one module, `src/serialize.ts`, and
make the measurement **call the renderer** rather than approximate it:

```ts
export function serializedChars(messages: readonly Message[]): number {
  return serializeEngineMessages(messages).length;
}
```

`messageChars(message)` becomes `serializedChars([message])`, kept for the
per-message callers (the benchmarks). `src/pi-adapter.ts` re-exports the renderer
from its new home, so no call site changed.

Exactness is now structural. There is no second implementation to keep in sync,
so the ratio cannot disagree with the string it describes.

The `\n\n` separators are the one thing `messageChars` still omits, because they
belong to the join between messages rather than to any one message. The ratio
uses `serializedChars` on the whole list, so it includes them; the per-message
figure is only used where a relative size is wanted.

## The same change exposed a second bug

With the accounting exact, five tests failed. They were not broken by the
refactor — they were **reporting a real defect the mirrored numbers had been
hiding**: dropping a call can make the transcript *larger*.

A `drop_call` replaces the output with a ~72-character note. Measured:

```
output   kept   dropped
  10ch     72      119    grows by 47
  50ch    112      119    grows by 7
  72ch    134      119    shrinks
 100ch    162      119    shrinks
```

Jev answers "is this still needed", not "is this bigger than the note", so the
decision cannot come from Jev. `applyDecisions` now compares
`keptCallChars(input, output.length)` against `droppedCallChars(tool, input)` and
keeps the call when discarding would not shrink the transcript. The
`discarded` set records what was really discarded, so the paired `toolResult` is
filtered only when its call was really dropped.

The test fixture had used ~18-character outputs, which is why this never
surfaced: every call in it was in the "grows" region. It now emits output longer
than the note, matching real sessions (measured average ~800 chars).

## Alternatives considered

**Fix the mirrored arithmetic.** Add the prefixes, the note and the separators to
`messageChars`. This is what the previous fix did, and it drifted again — the
renderer has four part kinds and a conditional note, so every future edit to it
is a chance to forget. Rejected: it treats the symptom.

**Compare rendered lengths only for the ratio, leave `messageChars` as is.** The
ratio would be right while the per-message figure stayed wrong, and the
short-output bug would remain invisible because the guard would still use the
wrong numbers. Rejected.

**Have Jev decide whether dropping is worth it.** The question would have to
include the note length and the output length, and Jev's probabilities are
calibrated for relevance, not for arithmetic. Rejected: this is a computation,
not a judgement.

**Always drop, accepting small growth.** Growth is bounded (~72 chars per call)
and the total is still a large net reduction. Rejected: a compaction whose stated
purpose is shrinking the context should never make it bigger, and the
notification would report a negative reduction for a short-output session.

## Consequences

- The reported ratio equals the serialized summary's true size. Verified against
  two recorded compactions from a real session: deviation `0.0000` points, where
  it had been 3.94.
- The second compaction's notification changes from 78.42% to 76.99% — the same
  compaction, honestly measured. Sessions near the 0.3 threshold may now defer to
  pi where they previously proceeded.
- Calls with output shorter than ~72 characters are kept rather than traced. In a
  real session this preserved 14 of 50 outputs under 120 characters. The cost is
  a slightly larger summary; the benefit is that the transcript never grows and
  no trivially short output is replaced by a longer note.
- `src/serialize.ts` is now the single place where "what does the summary look
  like" is answered. Any future change to the format automatically changes the
  accounting.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::size accounting is exactly the serialized length, for any message`
- `plugins/jev-compact/test/engine.test.ts::messageChars is the serialized length of that message`
- `plugins/jev-compact/test/engine.test.ts::a very short output is kept rather than replaced by a longer note`
- `plugins/jev-compact/test/engine.test.ts::an output larger than the note is discarded as asked`
- `plugins/jev-compact/test/engine.test.ts::no decision can grow the transcript`
- `plugins/jev-compact/test/engine.test.ts::the default answer keeps everything and removes nothing`

Proved: with the mirrored accounting restored in `serializedChars` (the pre-fix
implementation), `size accounting is exactly the serialized length, for any
message` and `messageChars is the serialized length of that message` both failed.
With the short-output guard removed from `applyDecisions`, `a very short output
is kept rather than replaced by a longer note` and `no decision can grow the
transcript` both failed. Restoring each fix returned the suite to 97 pass, 0
fail.
