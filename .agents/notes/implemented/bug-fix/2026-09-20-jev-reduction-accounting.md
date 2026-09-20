# Agent Note: The reduction ratio must measure rendered output, not raw input

Status: implemented

## Problem

`MIN_REDUCTION` decides whether a Jev compaction replaces pi's summary or defers
to it. On a real session the plugin reported **2.79%** and fell back, printing:

```
Jev compact: only 3% removable, using pi's summary instead
```

The actual output was 11.37% smaller. The gate therefore threw away a real
compaction because the number it compared was wrong.

The cause is `messageChars`, which estimated a message's contribution from the
**raw input**:

```ts
for (const tool of message.toolUses) total += JSON.stringify(tool.input).length;
```

That was fine until `drop_call` began keeping a trace. A discarded `write` keeps
its entire `content` on the `ToolUse` — so the trace can name the file — but the
serializer renders it clipped to ~200 chars. Measuring the input charged the
summary for bytes it would never contain. For a single 20 KB `write` the
overstatement was **113x**; across a real session it made the ratio disagree with
the output by **3.5x**.

The first fix attempt replaced the raw input with a flat upper bound (600). That
made things worse in a more visible way: the bound exceeded the real rendering of
short calls, so `charsAfter` grew while `charsBefore` did not, and the ratio went
**negative** (`-9.66%` on a 12-call fixture). A negative "reduction" is not a
tuning problem; it is a broken measurement.

## Decision

The trace renderer moved from `src/pi-adapter.ts` into `src/jev/compact.ts`, and
`messageChars` calls it directly:

```ts
total += tool.removed ? renderTraceArgs(tool.input).length : safeJsonLength(tool.input);
```

One function now serves both the serializer and the accounting, so they cannot
drift. This required moving `renderTraceArgs` and its two bounds out of the
adapter — the adapter already imported types from the engine, and `compact.ts`
cannot import from `pi-adapter.ts` without a cycle, so the engine is the only
place both can reach.

The flat-bound variant was rejected because an *approximation* of a rendered size
is exactly what produced the negative ratio. The measurement has to be the same
computation as the rendering, not an estimate of it.

`charsBefore` still measures the raw input and `charsAfter` the output. That
asymmetry is correct: they answer different questions, and the ratio is
`1 - output/input`, which is what a caller wants.

## Alternatives considered

**Keep the flat 600-char bound.** One line, no cross-module move. Rejected after
it produced a negative ratio — the bound is an over-estimate for every call
smaller than 600 chars, which is most of them.

**Have `messageChars` import from `pi-adapter.ts`.** Would keep the renderer
where it was. Rejected because it inverts the dependency: `pi-adapter` imports
`Message`/`ToolUse` from the engine, so importing back would create a cycle.

**Measure only `charsBefore`, report no ratio, drop the gate.** Simplest, and it
removes a class of bug. Rejected because the gate is load-bearing: without it a
zero-reduction compaction would replace pi's structured summary with a
verbatim transcript, which is a worse outcome than deferring.

**Count the trace at its bound but floor the ratio at zero.** Hides the negative
number without fixing the disagreement. Rejected — the ratio is also written to
`details.reductionRatio` and shown to the user, so it must be true.

## Consequences

The ratio now agrees with the serialized output to within serializer overhead
(marker prefixes and blank-line separators, ~100 chars per message). On the real
session the corrected figure is 11.37% against a measured output, versus 2.79%
before — enough to cross the 10% gate.

A `removed` call is measured at its clipped size, so a summary full of discarded
`write` calls reports the large reduction it actually achieves instead of the
modest one the raw inputs implied.

The engine now owns a rendering concern (character clipping), which is a slight
widening of its role. The alternative is two implementations of the same rule,
and the drift between them is what this note exists to prevent.

Residual: `messageChars` does not model the `[Tool result]: (output discarded…)`
label, so it under-counts by ~60 chars per removed call. That is a fixed cost
independent of message size, and it biases the ratio slightly *downward* — the
safe direction, since it can only cause a deferral, never an over-eager
compaction.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::a removed call is measured as its clipped trace, not its raw input`
- `plugins/jev-compact/test/engine.test.ts::size accounting is an exact match for a kept call`
- `plugins/jev-compact/test/engine.test.ts::a fully dropped transcript reports a positive reduction`

Proved: restored the raw-input measurement (`total += safeJsonLength(tool.input)`)
→ `a removed call is measured as its clipped trace, not its raw input` failed
(counted 20,018 for a call that renders ~250), then reverted and re-ran green
(81 pass, 0 fail). The flat-bound intermediate was also observed to fail, with a
negative ratio (`-9.66%`), while building the fix.
