# Agent Note: A discarded call's trace must be clipped

Status: implemented

## Problem

The previous fix kept a discarded call as a "trace" — the tool name plus its
arguments — so the output stayed re-obtainable. The reasoning was that a trace
is much smaller than the output it replaces.

That reasoning is wrong for the two tools that matter most. `write` and `edit`
carry the **entire file body** in their arguments, so `content="…"` is
byte-for-byte the same size as the result that was just discarded. The trace is
not a pointer; it is a copy with a different label.

Measured on the real compaction entry in
`2026-09-19T14-39-59-062Z_01a0ba1c-…jsonl`, which ran with the trace behaviour:

```
summary                     822,945 chars
  [Assistant tool calls]    489,391   (59.5%)
  [User]                    250,893   (30.5%)
  [Assistant]                52,820    (6.4%)
  [Tool result]              29,842    (3.6%)
```

The tool-call traces alone were 59.5% of the summary. The ten largest were all
`write`, at 11–14 KB each. The fix that was meant to preserve information had
become the dominant cost of the summary — and the summary was 3.3× the size of
the Morph compaction it replaced, in a plugin whose purpose is to shrink context.

## Decision

Trace arguments are clipped at two levels, applied only to a **discarded** call
(`tool.removed === true`); a kept call still renders its arguments in full, so it
stays consistent with the result stored beside it.

| Bound | Value | Why |
| --- | --- | --- |
| `TRACE_ARG_CHARS` | 200 | clips one huge argument (`write`'s `content`) |
| `TRACE_TOTAL_CHARS` | 600 | stops one giant call from dominating a run |

The elided size is reported inline — `…(12802 more)` — so the model can tell a
clipped trace from a short one. The key is never dropped.

The critical detail is *where* the cut happens. Cutting the rendered string
(`renderArgs(...).slice(0, 600)`) is simpler and wrong: `write` orders its
arguments as `content` then `path`, so a prefix cut keeps the file body and
**loses the path** — destroying the one fact the trace exists to preserve. Each
value is therefore clipped on its own, before joining, which guarantees every key
survives.

### Result

Reproduced on the exact slice pi passed to the summarizer (673 messages, 360
tool calls, matching the recorded `stats.calls = 360`):

```
before (as recorded)   822,945 chars
after                  177,537 chars     (-78.4%)

traces                 361 / 361 carry a path or command
trace bytes            93,303            (52.6% of the summary)
trace median / max     249 / 2,889
```

Every call is still traceable and every trace still names its target, but the
summary is under a quarter of its former size.

## Alternatives considered

**Drop only the largest argument, keep the rest verbatim.** Would fix `write`
specifically. Rejected as a special case: any tool can take a large argument, and
a general cap needs no per-tool knowledge.

**Clip the rendered argument string.** One line instead of a loop, and it fails
the whole purpose — see above, the path is lost. This is the trap worth naming,
because the naive version looks correct and passes any test that only checks
size.

**Keep a hash or byte count instead of any content.** Maximally small, but
`content=…#(3000 bytes)` says nothing about *what* the file is; the path is what
makes the call re-runnable, and it must stay.

**Don't clip, and accept the size.** Defensible if the reader benefits from the
full argument. Rejected because the argument is a duplicate of a file that
already exists on disk: the model can re-read it, and the summary is exactly the
place where that duplication is most expensive.

## Consequences

The summary for a call-heavy session drops by roughly 4× while remaining a
complete work record — the trade is that a trace no longer shows what was
written, only where.

A clipped trace is distinguishable from a complete one by the `…(N more)`
suffix, so the model can choose to re-read when the content actually matters.

The bounds are module constants rather than configurable. They are a rendering
concern, not a compaction policy, and exposing two more environment variables
would imply a tuning decision that does not exist — the right value is "small
enough to stay a pointer", and 200/600 achieves that for every tool observed.

## Verification

Tests live in `plugins/jev-compact/test/pi-adapter.test.ts`.

- `plugins/jev-compact/test/pi-adapter.test.ts::a discarded write renders a small trace, not the file body`
- `plugins/jev-compact/test/pi-adapter.test.ts::a kept call still renders its arguments in full`

Proved: replaced the clipped renderer with the unbounded one
(`const args = renderArgs(tool.input)`) → `a discarded write renders a small
trace, not the file body` failed on line length (20,000-char body rendered in
full), then reverted and re-ran green (78 pass, 0 fail). Verified against the
real session slice: 361/361 traces retain a path or command, summary 823 KB →
178 KB.
