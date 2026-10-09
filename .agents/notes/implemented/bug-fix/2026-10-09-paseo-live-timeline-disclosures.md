# Agent Note: Match live subagent activity to the main timeline

Status: implemented

## Problem

The companion's live subagent screen expanded every thinking block, tool
argument and result with custom Completed/Streaming labels. An unfinished
child therefore looked like a raw log instead of the main agent's compact
Thinking and Shell activity rows.

## Decision

Render thinking and tools as themed disclosure rows with host icons, a tool
label and a single-line argument summary. Thinking and completed tools start
collapsed. Running and failed tools expose details by default; completion
collapses an untouched running row. User disclosure choices survive ordinary
polling updates. Assistant text remains visible without an extra status label.
Give each block a stable identity and use it as the React key. Tool rows use
tool-call IDs; message parts use their message timestamp and content index,
with an absolute JSONL byte position fallback. Streaming parts retain their
identity on authoritative completion. Absolute byte positions remain stable
when the scan window moves, including logs with multi-byte UTF-8 text. Terminal
consumers do not request identities and retain their original block shape.
Keep bounds, polling and navigation unchanged.

Use the installed Paseo 0.11 bundle as the source for layout: AgentStreamView
centers an 820 px column with 8 px inset; ToolCallMessage uses 4 px vertical /
8 px horizontal padding, a 22 px icon badge and 12 px icons. Consecutive
activity rows have no extra gap. Read uses Eye, write/edit Pencil and unknown
tools (including ls) Wrench, following the host detail-type icon resolver.
The screen uses surface0 behind the transcript.

## Alternatives considered

- Import the native timeline renderer: the 0.11 public plugin SDK does not
  export it; private app imports would break the external plugin boundary.
- Keep expanded logs and change their colors: preserves the interaction mismatch.
- Navigate only to the native child page: loses unfinished foreground output
  on hosts that register the transcript only after settlement.

- Array-index keys: evicting a head block migrates disclosure state to a
  different tool. Content hashes also collide for repeated identical commands.

## Consequences

This is a small compatibility renderer using the main timeline's disclosure
convention, not direct reuse of the unavailable host component. Future public
SDK timeline components should replace it. The public theme currently exposes
colors only, so custom host font size and content width cannot be synchronized;
use the verified native defaults until those metrics are public. Details remain selectable and
accessible through labeled buttons with expanded state. Long summaries
truncate to one line, while expanded arguments and results remain readable.

## Verification

- Test file: `integrations/paseo-ui/test/live-output.test.ts`

- `integrations/paseo-ui/test/live-timeline.test.tsx` pins collapsed thinking and
  finished tools, command summaries, streaming output and failure details.

Proved: temporarily forced every activity row expanded, recreating the original
log behavior. The focused test run failed with 1 pass / 1 fail because the
collapsed disclosure was absent and thinking/result bodies were visible.
Restoring the default disclosure policy passed both tests. The integration
suite passed all 30 tests and its typecheck passed. Browser verification of
the actual React component with DOM adapters confirmed Thinking expansion,
untouched-tool collapse on completion and retention of manually expanded
Thinking across updates. Native primitives and icons still require a real
Paseo run for final host verification.

Additional proof: before applying the native layout adapter, the new native
column/row/icon regression failed (2 pass / 1 fail): no max-width:820px, 16 px
icons and FileText/FilePen/Folder instead of the host mappings. Applying the
adapter passed all 3 focused tests and 31 companion tests.


Additional proof: the four-fix red run (16 pass / 7 fail) included failures in
`integrations/paseo-ui/test/live-output.test.ts::activity identities survive bounded-tail shifts, repeated commands and completion`
and `integrations/paseo-ui/test/live-timeline.test.tsx::disclosure keys stay with the same activity when the window advances`.
The reader had no identity and the remaining row changed its reconciliation key
from 1 to 0. Both pass with stable identities and React keys. The additional
`integrations/paseo-ui/test/live-output.test.ts::identical text blocks retain absolute byte identities as the scan and response windows slide`
test checks duplicate text and moving UTF-8 byte windows.
