# Agent Note: Folding a summary back in must be idempotent

Status: implemented

## Problem

A second compaction does not receive the older history. pi excludes everything
before the previous compaction's `firstKeptEntryId` and hands the earlier summary
back as `preparation.previousSummary`, so the extension folds it back in as the
leading message:

```ts
text: 'The conversation history before this point was compacted into the ' +
      'following summary:\n\n' + preparation.previousSummary
```

That text is then serialized, stored as the new summary, and handed back verbatim
by pi on the *next* compaction — because `previousSummary` is
`prevCompaction.summary`, the string the handler returned, with no prefix of its
own. The framing therefore becomes part of the stored summary, and the next
compaction adds another copy. One layer per compaction, forever.

Measured on a real session across three Jev compactions:

```
条目  1302 (jev-compact)  prev=morph        → 1 frame
条目  1887 (jev-compact)  prev=pi           → 1 frame
条目  2142 (jev-compact)  prev=jev-compact  → 2 frames   ← nested
```

The stored summary began:

```
[User]: The conversation history before this point was compacted into the following summary:

[User]: The conversation history before this point was compacted into the following summary:

[User]: ## Goal
- Build a **pi plugin host monorepo** ...
```

Each layer is ~94 characters of pure overhead the model has to read, and the
count grows without bound: the 50th compaction would carry 50 nested frames.
It also pushes the real content further from the start of the summary, which is
where a reader — and the model — looks first for the task.

The bug is invisible from a single compaction. It needs the same plugin to run
twice in a row, which is exactly what the earlier fix
(`jev-second-compaction-drops-history`) made possible: before it, the second
compaction dropped the prior history entirely, so no summary ever came back
framed.

## Decision

Strip the framing before adding it, making the fold-in idempotent:

```ts
export function stripCompactionFrame(summary: string): string {
  const framed = `${USER_MARKER}${COMPACTION_FRAME}`;
  let text = summary;
  while (text.startsWith(framed)) text = text.slice(framed.length);
  return text;
}
```

then

```ts
text: COMPACTION_FRAME + stripCompactionFrame(preparation.previousSummary)
```

Two details matter:

- **Only the complete unit is stripped** — `[User]: ` *immediately followed by*
  the frame. Stripping a bare `[User]:` marker would delete the marker that
  legitimately begins a serialized transcript, and stripping a bare frame would
  remove text this extension did not write. The pair is what we emitted, so the
  pair is what we remove.
- **The loop collapses, not just avoids.** Sessions compacted before this fix
  already carry several layers. Unwinding them on the next compaction bounds the
  count at one instead of freezing it at whatever it had reached. Verified
  against the real summary: 2 frames in, 1 frame out.

The constant is exported (`stripCompactionFrame`) so the tests can pin the
marker-only and frame-only cases directly, without driving a whole compaction.

## Alternatives considered

**Stop adding the frame at all.** The summary would be bare text. pi already
wraps a stored summary in its own `COMPACTION_SUMMARY_PREFIX` when building
context, so the model would still see framing — but a summary read on its own
(a log, a test fixture, `previousSummary` handed to another tool) would not
explain what it is. Rejected: the frame is useful; it just must not accumulate.

**Strip the frame from `previousSummary` but keep adding it unconditionally.**
This is the chosen fix; stated separately because the tempting shortcut is to
strip a bare marker with `replace(/^\[User\]: /, '')`, which is wrong for the
reason above.

**Deduplicate at serialization time.** Collapse repeated frames in
`serializeEngineMessages`. Rejected: that module renders whatever it is given,
and a legitimate transcript could contain the frame text inside a quoted tool
result. Removing it there would corrupt content; removing it at the fold-in
touches only the string we ourselves created.

**Change what `previousSummary` is.** Not possible — pi chooses it, and the
`CompactionResult` type has no field to influence it.

## Consequences

- The fold-in is idempotent: ten consecutive rounds produce exactly one frame,
  verified against the real summary (`180,919 → 180,825` chars, content intact).
- Summaries already nested by earlier versions are repaired on the next
  compaction rather than extended.
- The `[User]: ` marker that begins every serialized transcript is preserved, and
  a frame-like string inside quoted content is untouched.

## Verification

Tests live in `plugins/jev-compact/test/hook.test.ts`.

- `plugins/jev-compact/test/hook.test.ts::the framing does not nest when a prior summary is folded in again`
- `plugins/jev-compact/test/hook.test.ts::framing already nested by earlier versions is collapsed, not extended`
- `plugins/jev-compact/test/hook.test.ts::a bare [User]: marker is not mistaken for framing`
- `plugins/jev-compact/test/hook.test.ts::previousSummary is folded back into the summary`

Proved: with the fold-in reverted to `COMPACTION_FRAME + preparation.previousSummary`
(the pre-fix line), `the framing does not nest when a prior summary is folded in
again` and `framing already nested by earlier versions is collapsed, not
extended` both failed. Restoring the strip returned the suite to 100 pass, 0 fail.
