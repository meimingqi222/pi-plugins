# Agent Note: Render workflow completion as an answer

Status: implemented

## Problem

The settled workflow message serialized the entire run result as JSON. A multiline Markdown answer became a quoted `value` with escaped newline markers and buried the actual findings among run metadata. The TUI had no custom renderer for this custom message, so a long answer filled the transcript as an unreadable block.

## Decision

Keep the run record in message details and the journal. Put a short run summary and the answer with its original line breaks in the message body. Register a `workflow-result` renderer: compact status in the collapsed TUI state, full Markdown answer when expanded. Structured answers remain pretty-printed JSON text.

## Alternatives considered

**Only add a TUI renderer.** Other Pi surfaces would still receive escaped JSON in the message body.

**Drop the run metadata.** The run id, status, usage and cache hits help correlate the answer with `/workflows` and the journal, so they stay in the summary and details.

## Consequences

Human readers can see the answer directly and expand it in the TUI. The model still receives the full answer, and callers needing the complete structured record use message details or the run journal. Existing session messages keep their old stored text until a new workflow settles.

## Verification

- `plugins/workflow/test/plugin-wiring.test.ts`
- `plugins/workflow/test/plugin-wiring.test.ts::a multiline workflow answer is delivered as readable text with an expandable TUI renderer`

Proved: before the change, the bound test failed because the delivered body contained `"value"` and escaped newline markers instead of line breaks. After the change, it checks the readable body and both collapsed and expanded TUI rendering.
