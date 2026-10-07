# Agent Note: Populate Paseo subagent pages with pi transcripts

Status: implemented

## Problem

Host-compatible status updates alone left child pages blank. Paseo's pi adapter
hydrates an optional outputFile only at terminal turn boundaries and reads each
immutable path once, with limits of 2 MiB and 200 timeline items. Raw evidence
contains repeated starts/deltas and asynchronously queued writes, so publishing
its path is not a reliable transcript.

## Decision

The shared runner offers an opt-in raw event observer on both JSON and RPC
transports. It fires synchronously before RPC settlement; observer exceptions
cannot fail execution. Subagent policy collects only complete message_end
records, bounds message data and timeline weight, and publishes private,
immutable pi-message snapshots before its host update. Raw log paths remain
private in public Lane views; the host receives a registry path resolver.

Both foreground and background launches expose transcripts. Replies drain only
new entries to a new file. Assistant response IDs are unique across snapshots,
so the history mapper cannot overwrite earlier turns with reused index IDs.
Failure/cancellation always includes an explanatory terminal message. Session
generation guards reject late events, and send failures retain the published
file for retry. Snapshots use the existing log retention policy.

## Alternatives considered

- Publish raw logs: duplicates streaming snapshots, can race evidence flush,
  and can hit the byte cap before the answer.
- Patch Paseo: unnecessary for terminal transcript support and fragile on updates.
- Reuse a mutable path: Paseo reads each path only once, leaving replies stale.

## Consequences

Pages show completed-turn execution content. They do not stream updates during
an active turn on Paseo 0.10.3. Old sessions are not reconstructed. Large output
is truncated, and transcript files count toward the existing 200-file retention.

## Verification

- `plugins/subagent/test/host-transcript.test.ts` locks message selection,
  duplicate suppression, immutable reply deltas, byte/item bounds and abort text.
- `plugins/subagent/test/paseo.test.ts` locks background failure transcripts and
  foreground spawn-call correlation using actual plugin execution, including
  timeout and thrown executor failures. Foreground exceptions return structured
  failed details so Paseo can correlate the subsequent transcript notification.
- `plugins/agent-runner/test/rpc-child.test.ts` locks observer-before-settlement
  ordering and exception isolation.
- `plugins/agent-runner/test/executor.test.ts` locks JSON observer wiring.

Proved: the new host-transcript test failed before implementation with
Cannot find module ../src/host-transcript.ts. The plugin integration assertions
also failed with no outputFile until the private registry log path was resolved.
Read-only verification against the installed Paseo 0.10.3 mapper and child-session
loader produced user_message, reasoning, running/completed tool_call and the
timeout assistant_message; reply snapshot message IDs remained distinct.

Validation: full workspace 1293 pass, zero failures, 12 platform skips. After final
exception-path coverage, subagent suite 152 pass and its typecheck passed.
The notes gate passes after migrating the archive manifest from raw-byte to
LF-normalized hashes; the archived note content is unchanged.
