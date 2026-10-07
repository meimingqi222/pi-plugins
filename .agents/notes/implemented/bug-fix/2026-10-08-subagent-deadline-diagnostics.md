# Agent Note: Diagnose and budget subagent task deadlines independently of upstream failures

Status: implemented

## Problem

Three reported reviewers all failed at the 900-second child deadline. Raw event logs show two completed 58 and 104 tools, respectively, with no outstanding tool or upstream error at termination. Another had 30 completed tools and was awaiting a bash test command with a 600-second declared timeout, started when only about 397 seconds remained in the total task budget. Its redirected test log stopped inside a local controls test. A declared tool timeout only extends the silence allowance, not the total task deadline.

The generic failure text made these distinct situations look like upstream timeout failures. Tool activity was removed from failed results, while default answer text exposed long absolute event-log paths and an unbroken task-id-first status line. The Paseo companion also handled status messages but not task inspection tool output.

## Decision

Use a 1800-second (30-minute) default hard task deadline, with an explicit subagent timeout parameter and PI_SUBAGENT_TIMEOUT_SECONDS default override, bounded to 1–10800 seconds (three hours). Both JSON and live RPC transports receive the selected budget. Continuous activity never resets this bound. Invalid values fail explicitly rather than disabling the deadline.

Deadline diagnostics identify the total task budget and the last event and quiet duration. Upstream error text remains unchanged. Failed child results retain the active tool. Default failure content omits the event-log path suffix; full diagnostic text stays in details and explicit log inspection. Task summaries place the human task title first and the full control identity on a separate line. Bash notices are short status-only summaries with one output retrieval instruction.

The optional Paseo companion renders list/show/wait inspection results for running or failed tasks. It leaves successful answers, controls, raw log output and unsupported shapes native. Cards show a short id while retaining full identity in their data and accessibility label. Paseo source remains unchanged.

## Alternatives considered

- Blame upstream speed: the observed logs contain no upstream errors, and the long-running command was a local test suite. Event snapshots cannot measure provider latency reliably.
- Increase every deadline automatically: would hide stuck tools and increase spend; broad review scopes should be split or explicitly budgeted.
- Reset the deadline on every output: a looping child could run indefinitely.
- Drop all diagnostic information: would make the next failure harder to distinguish; details retain the complete evidence.

## Consequences

Long tasks can request a bounded larger budget, but a tool may still outlive the remaining child budget. The local controls-test hang is outside this repository and has not been patched here. Existing historical messages are not rewritten. Default text is more readable in older hosts, while cards still require a capable Paseo client. Detailed logs are available without occupying the normal conversation.

## Verification

- `plugins/subagent/test/deadline-display.test.ts::task deadline is configurable and failure display preserves tool evidence without exposing log paths`
- `plugins/subagent/test/deadline-display.test.ts::environment deadline has explicit precedence and rejects unbounded values`
- `plugins/subagent/test/deadline-display.test.ts::inspection separates readable title and activity from the full task identity`
- `plugins/agent-runner/test/deadline-diagnostic.test.ts::deadline failures distinguish total budget from upstream timeouts and preserve last activity`
- `plugins/subagent/test/paseo.test.ts::RPC launch reports readable progress before the child finishes`
- `integrations/paseo-ui/test/status.test.ts::task inspection cards hide diagnostic paths and preserve successful answers and control output`

Proved: Forced the task budget back to 900000ms; the selected 1800000ms assertion failed. Restored and reran green. Output: `regression-evidence/deadline-budget-red.txt`.

Proved: Disabled display path omission; the content assertion found C:/private. Restored and reran green. Output: `regression-evidence/deadline-display-red.txt`.

Proved: Unconditionally removed activeTool on failure; the bash activity assertion received undefined. Restored and reran green. Output: `regression-evidence/deadline-tool-red.txt`.

Proved: Removed last-event forwarding in outcome mapping; the diagnostic assertion lost tool_start bash and its quiet duration. Restored and reran green. Output: `regression-evidence/deadline-diagnostic-red.txt`.

Proved: Before the requested policy change, the environment/default regression expected 1800000ms but received 900000ms. After updating the default and maximum, it verifies the 10800-second parameter/schema/environment boundary and rejects 10801 seconds. Output: `regression-evidence/subagent-three-hour-red.txt`.
