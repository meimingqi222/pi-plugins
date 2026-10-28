# Agent Note: Native subagent prompt card, Info icon and full history toggle

Status: implemented

## Problem

Paseo companion's subagent output view omitted the initial prompt card visible
in native child pages, used a non-native Brain icon for Thinking rows instead of
the host Info (`ⓘ`) convention, and strictly capped output to 120 blocks / 256 KiB
from the tail with no way for users to inspect the full execution trace. Simply
removing all limits would flood RPC bandwidth and freeze the React Native render
loop during high-cadence polling on large transcripts. The first expansion
implementation also retained a no-op Show all button when expanded output was
still truncated, hid the return-to-recent action, and let unbounded task prompts
bypass the output response budget.

## Decision

The subagent transcript parser and companion server RPC now extract the initial
task prompt from transcript headers even when scanning from a tail offset. The
Thinking disclosure row adopts the host Info icon (`ⓘ`). The output screen renders
a dedicated task prompt card matching native styling, replaces the redundant
two-row header with a compact single-row header (subagent task title + ID, output-connection
status indicator, dedicated Auto-scroll toggle and sleek RefreshCw action, reducing vertical
overhead by ~40% and eliminating duplicate Follow output labels), preserves the
compact 120-block tail window by default for low latency, and provides an on-demand
"Show more history" toggle with memoized activity rows and collapsed-detail lazy
rendering. Expansion scans
at most 16 MiB and returns at most 2000 blocks under a 2 Mi-character serialized
JSON budget. If earlier output remains omitted, explicitly state the display
limit and always show Show recent only; repeating the expansion action cannot
load a larger window. The normal response uses a 256 Ki-character budget.

Task prompts are previews capped at 16000 characters, with optional
`promptTruncated` metadata displayed in the task card. Budget the complete JSON
envelope including the escaped prompt, metadata and array separators before
admitting output blocks, preserving the most recent contiguous output window.

## Alternatives considered

- Remove limits unconditionally: causes IPC serialization thrashing and render stalls
  during active 750 ms polling.
- Render prompt as an artificial activity block: breaks existing downstream TUI
  transcript blocks and timeline counts.
- Keep fixed tail omission with no toggle: prevents inspecting early execution actions.

## Consequences

The companion output screen matches native appearance more closely while giving
users bounded access to additional history without claiming unlimited recall.
Users can always exit expanded mode, including when its limits still omit data.
Prompt clipping affects display only; task input and raw evidence are retained.

## Verification

- `integrations/paseo-ui/test/live-output.test.ts` pins prompt extraction from transcript
  head and `all: true` history recall when it fits the display limits.
- `integrations/paseo-ui/test/live-timeline.test.tsx` pins the native Info icon for thinking rows.
- `plugins/subagent/test/transcript.test.ts` pins initial user prompt capture in `foldSubagentLog`.

- `integrations/paseo-ui/test/live-output.test.ts::long prompts share the serialized response budget with output blocks`
- `integrations/paseo-ui/test/live-output.test.ts::expanded history reports remaining omissions at its display limit`
- `integrations/paseo-ui/test/live-timeline.test.tsx::truncated expanded history remains escapable instead of offering a no-op show-all action`
- `integrations/paseo-ui/test/live-timeline.test.tsx::history controls expand recent output and can return even from a short expanded response`

Proved: before the fix, the prompt-budget test returned 700000 characters where
at most 16000 were expected, and the actual history controls rendered Show all
output without a Show recent only action despite already being expanded. The
local red run is saved in `regression-evidence/paseo-history-prompt-budget-red.txt`.
The same tests pass after the fix, including escaped JSON text and the expanded
history display cap.
