# Agent Note: Release workflow lease and origin handles on session leave

Status: implemented

## Problem

`leaveSession` bumped the session generation, aborted every run, and disposed
the footer, but the per-run entries in `goalLeases` and `origins` were removed
only from the registry's settle callback. `stopAll` only aborts; settlement
runs through the work promise. An executor that ignores abort therefore kept
both entries — and the launch `ctx` the origin closure captures — alive until
extension unload. Closing those leases at zero also discarded usage already
reported in progress. An abort-ignoring executor kept its registry slot active,
so a later session could be refused at the run limit.

## Decision

On leave, finish every outstanding goal spend lease with the latest reported
`goalTokens` (zero when no usage was reported), clear both maps, and reset the
run registry. Reset aborts and drops active runs immediately, freeing capacity
even when work ignores abort. Delivery was already guarded after a leave by
the session generation; a late settle is ignored by the reset registry.

## Alternatives considered

**Delete the maps only on `session_shutdown`.** Branch switches within one
session (`session_before_switch` / `session_before_tree` /
`session_before_fork`) are leaves too, and an abort-ignoring executor crosses
any number of them.

**Clear `goalLeases` without finishing the leases.** The goal-side
`pendingDelegations` set removes its key only inside `finish`, so a bare delete
would leak the key there and could pin a deferred verifier run.

## Consequences

Leaving a conversation releases leases, closures, and run slots even when
abort is ignored. Already reported usage is billed once before the old goal
branch is left. A run that settles afterwards delivers nothing and reports
no additional spend or status in the new session.

## Verification

- `plugins/workflow/test/plugin-wiring.test.ts`
- `plugins/workflow/test/plugin-wiring.test.ts::leaving a session releases the goal lease and origin handles even when the run never settles`
- `plugins/workflow/test/plugin-wiring.test.ts::leaving a session bills the workflow usage already reported in progress`
- `plugins/workflow/test/plugin-wiring.test.ts::leaving a session releases the active run slot even if abort is ignored`

Proved: with the cleanup lines removed the test failed at the leave boundary
(`expected [0], received []` — the lease was never finished); restoring them
made it pass, and the late settle still produced no delivery and no second
spend report.

Follow-up: closing at zero failed the progress-usage test (`expected [9],
received [0]`). Keeping `stopAll` without resetting the registry failed the
run-slot test because the next launch rejected at the active-run limit. Both
tests pass after billing the progress snapshot and resetting the registry.
