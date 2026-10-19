# Agent Note: Carry previous summaries into Morph compaction

Status: implemented

## Problem

Pi supplies previousSummary separately from the new messages. Morph's optional
compaction hook omitted it, so a second compaction silently lost older history.

## Decision

Prepend the previous summary as one user message before calling Morph. Do not
parse its role markers as fresh turns or add another framing layer. The existing
summary selection and fallback to Pi remain unchanged.

Construct service messages directly from `convertToLlm`'s structured messages.
Only the structured role controls the service role; literal line-start role
markers in user text or tool output remain content. Assistant thinking and tool
call names/JSON arguments remain labeled text inside the assistant message,
alongside assistant text. Tool result text maps to the service's tool role.
Do not serialize the whole conversation and reparse role-looking lines: escaping
or extending that parser still loses an unambiguous message boundary. The adapter
keeps textual tool output rather than inheriting the summary serializer's
truncation. Non-text image blocks are not sent as text, as before.

## Alternatives considered

Trusting Pi to prepend history fails when the extension supplies the summary.
Appending old history after compression would make it impossible to compress
that history on later rounds and cause cumulative growth.

## Consequences

Successive Morph requests include earlier compacted context. Morph still performs
lossy compression; this change prevents omission at the adapter boundary, not
all possible information loss in the remote model.

## Verification

- `plugins/morph-search/test/compact-boundary.test.ts::structured compaction preserves literal role markers and tool thinking semantics`

Proved: the pre-fix hook split literal user/tool body markers into forged roles;
the exact captured-message assertion failed. Output saved to
`.agents/notes-evidence/2026-10-19-morph-structured-red.txt`. The same hook test
passes after structured conversion and pins thinking/tool-call text retention.

- `plugins/morph-search/test/plugin.test.ts`
- `plugins/morph-search/test/plugin.test.ts::successive compactions preserve the previous summary in the next request`

Proved: before the fix, the request contained only second round and failed the
original-constraint assertion. After the fix, two successive calls preserve the
constraint in the captured request and stubbed summary without network access.
