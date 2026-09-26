# Agent Note: Carry previous summaries into Morph compaction

Status: implemented

## Problem

Pi supplies previousSummary separately from the new messages. Morph's optional
compaction hook omitted it, so a second compaction silently lost older history.

## Decision

Prepend the previous summary as one user message before calling Morph. Do not
parse its role markers as fresh turns or add another framing layer. The existing
summary selection and fallback to Pi remain unchanged.

## Alternatives considered

Trusting Pi to prepend history fails when the extension supplies the summary.
Appending old history after compression would make it impossible to compress
that history on later rounds and cause cumulative growth.

## Consequences

Successive Morph requests include earlier compacted context. Morph still performs
lossy compression; this change prevents omission at the adapter boundary, not
all possible information loss in the remote model.

## Verification

- `plugins/morph-search/test/plugin.test.ts`
- `plugins/morph-search/test/plugin.test.ts::successive compactions preserve the previous summary in the next request`

Proved: before the fix, the request contained only second round and failed the
original-constraint assertion. After the fix, two successive calls preserve the
constraint in the captured request and stubbed summary without network access.
