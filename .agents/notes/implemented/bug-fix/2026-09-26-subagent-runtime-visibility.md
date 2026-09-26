# Agent Note: Subagent background runtime visibility and logs

Status: implemented

## Problem

Background subagent status exposed only a short metadata trail, while the runner's raw child event stream was not connected to subagent tasks. When a child failed or stalled, the parent could not inspect actual model and tool events.

## Decision

Project safe lifecycle metadata for routine status and retain the raw JSONL event stream in a private per-user log directory for explicit diagnostics. `subagent_tasks` offers `events` for a ten-entry metadata trail and `log` for bounded raw-log tail reads or case-insensitive full-log substring search. Raw evidence is capped at 20 MiB per task; search scans that bounded file, unfiltered reads scan only its latest 2 MiB, and each response is limited to 50 lines and 32 KiB. Logs are mode 0600, stored under `~/.pi/agent/subagent-logs` (overridable with `PI_SUBAGENT_LOG_DIR`), and pruned after seven days or above 200 files. Raw prompts, tool arguments, and outputs are exposed only on explicit log requests.

## Alternatives considered

**Keep only safe metadata.** This is suitable for routine liveness checks but cannot diagnose a failed tool call or inspect what a child actually emitted.

**Expose raw logs automatically in status.** This would leak prompts and tool data into ordinary status calls and produce large responses.

## Consequences

The parent can inspect the complete bounded JSONL stream when debugging, while routine status remains compact. Query and response caps bound file I/O and model context. Logs contain sensitive task and tool data, so they remain local and are returned only on request. Very large runs can reach the 20 MiB cap, after which the evidence file records a truncation marker.

## Verification

- `plugins/subagent/test/plugin.test.ts::explicit-log-action-reads-only-a-bounded-matching-tail`
- `plugins/subagent/test/logs.test.ts::safe-paths-and-full-log-query`
- `plugins/agent-runner/test/executor.test.ts::evidenceMaxBytes-bounds-the-raw-stream-and-records-truncation`

Proved: before log-path wiring, the explicit log test failed because the fake child received no evidence path; after wiring, the log query returned only the requested matching line. Before the evidence cap, the new cap test had no truncation marker; it passes with a bounded marker now.
