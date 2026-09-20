# Agent Note: A dropped call keeps a trace instead of vanishing

Status: implemented

## Problem

Following upstream `fast-jev-compaction`, a `drop_call` decision removed the
tool call *and* its result from the transcript. The rationale is sound in the
abstract — the assistant can re-run the tool — but it fails on the specific
thing a coding agent needs: **knowing what to re-run**.

Measured on a real pi session (570 summarizer messages, 307 tool calls):

```
assistant messages        251
  call-only (no text)      85   (34%)
  with text               166
```

Two distinct losses follow:

1. **A call-only message disappears entirely.** 34% of assistant messages carry
   no prose, only calls. Dropping the call drops the message, so nothing in the
   summary records that the work happened.

2. **Prose survives, its referent doesn't.** The remaining 166 messages keep
   their text — *"I'll check the config"* — while the call naming
   `src/config/defaults.ts` is gone. The narration now points at nothing.

The practical cost is that "re-run the tool" stops being an instruction the
model can act on. It has no path, no command, no arguments.

At the default threshold this is the common case, not an edge case. Measured on
the same session:

```
threshold | output+call removed | call trace kept | full
   0.2    |         12          |       292       |  0     (of 307)
   0.5    |        303          |         1       |  0
```

At `keepThreshold=0.5` — the default — 303 of 307 calls left no trace at all.

## Decision

`drop_call` now keeps the **call as a one-line trace** and discards only its
output. The trace is the tool name plus its arguments, which is exactly the
information that makes the output re-obtainable.

`ToolUse` gains a `removed?: boolean` flag to distinguish "output deliberately
discarded" from "the tool returned nothing". The serializer renders the
distinction explicitly:

```
[Assistant tool calls]: read(path="src/config/defaults.ts")

[Tool result]: (output discarded by compaction; re-run `read` if needed)
```

Without the label the trace would be indistinguishable from a call that
produced no output, and the model would have no reason to re-run it.

The three-way decision table is otherwise unchanged: `keep` keeps call and
result, `drop_result` keeps the call with a truncated result head, and
`drop_call` keeps the call with no result. The pairing entry is still removed
for a dropped call, so no result outlives its call.

Cost and benefit on the real session: **307/307 calls traceable** at a 66%
byte reduction. The compaction is still decisive, it just leaves a manifest.

Correction, found when this shipped: the claim that a trace "is a small fraction
of the output it replaces" was wrong for `write` and `edit`, whose arguments
contain the whole file body. On a real compaction the unclipped traces were
59.5% of the summary. `jev-trace-args-unbounded` fixes that by clipping each
value; the trace keeps its keys (so the path survives) and loses the bulk.

## Alternatives considered

**Keep upstream behaviour and document the caveat.** Simplest, and it matches
the vendored code. Rejected because the caveat is not a tuning issue: at the
default threshold it drops 99% of calls, and the failure is invisible in the
transcript. A summary that silently cannot be acted on is worse than one that is
larger.

**Keep only the dropped calls' *names*, not their inputs.** Cheaper still, but
`bash` without the command or `read` without the path says nothing useful. The
arguments are the point.

**Keep the first N characters of each dropped result** (a lower
`truncateHeadChars` for `drop_call`). Rejected because tool output rarely leads
with the useful part — a directory listing's interesting line is not usually its
first. A pointer to the source is more useful than a bad excerpt of it.

**Emit the trace as assistant text rather than a call.** Would survive a
text-only pipeline, but it would forge assistant prose that the model never
wrote, polluting the transcript's authorship. The call channel is the honest
place for a call.

## Consequences

Summaries are slightly larger for a given reduction, because every call now
contributes at least a line. On the measured session the reduction went from
around 96% (erasing calls) to 66% (tracing them) — the summary still removes
about two thirds of the bytes, and is now complete as a work record.

Because the trace includes `input`, a dropped `read` retains a full path and a
dropped `bash` retains its command. Very large tool inputs are still subject to
the state-fitting caps (`INPUT_CHARS`), but those apply to the state sent to
Jev, not to the trace in the output.

`stats.callsDropped` still counts "output discarded", which now means something
subtly different from "call removed". The field name is kept for continuity with
upstream; the README documents the meaning.

## Verification

Tests live in `plugins/jev-compact/test/engine.test.ts` and
`plugins/jev-compact/test/pi-adapter.test.ts`.

- `plugins/jev-compact/test/engine.test.ts::the call survives as a trace with its input intact`
- `plugins/jev-compact/test/engine.test.ts::a call-only message is not erased`
- `plugins/jev-compact/test/engine.test.ts::an emptied message is rebuilt, not silently returned unchanged`
- `plugins/jev-compact/test/engine.test.ts::no result outlives its call, and the trace is labelled in the output`
- `plugins/jev-compact/test/pi-adapter.test.ts::a tool result is rendered once, not also as user text`

Proved: restored the upstream behaviour by filtering dropped calls out of
`toolUses`. The first attempt at this red run exposed a second bug: only 2 of the
3 tests failed, because `[].every(...)` is vacuously true and the "nothing
changed" short-circuit therefore pushed the original message back. Adding an
explicit length check (`toolUses.length === message.toolUses.length`) made the
third test fail too, and all three now discriminate:

```
(fail) a call-only message is not erased
(fail) no result outlives its call, and the trace is labelled in the output
(fail) the call survives as a trace with its input intact
```

Then reverted and re-ran green (75 pass, 0 fail). Verified against the live
System One API on the real 307-call session: 307 call lines, 300 traces, 7 kept
results, 66% byte reduction.
