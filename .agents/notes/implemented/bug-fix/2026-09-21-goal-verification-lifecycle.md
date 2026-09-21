# Agent Note: Goal verification must fail closed and respect run ownership

Status: implemented

## Problem

A sidecar verifier may return plausible success JSON alongside a provider error.
Cancellation may also be ignored by the provider, allowing stale completion to
overwrite a paused or replaced goal. Repeated settled events can duplicate work.

## Decision

Require a clean stop reason and a strict evidence-bearing verdict. Pause on
verification errors, malformed output, timeout or cancellation. Race provider
completion against cancellation, and bind each result to its goal, session and
generation. Consume each ended work run once before starting verification.

## Alternatives considered

Trusting JSON alone accepts partial/error responses. Failing open falsely claims
success. Relying only on AbortSignal leaves uncooperative providers holding the
session event handler. A generation check alone prevents stale writes but does
not release that handler promptly.

## Consequences

Verification errors require explicit user resume. Cancelled provider requests
may still incur provider-side usage if transport cancellation is ignored; their
late results never modify a replacement goal. Transcript verification is not an
independent filesystem audit.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::provider error with plausible JSON cannot complete`
- `plugins/goal/test/lifecycle.test.ts::pause releases verifier even if provider ignores abort and ignores late completion`
- `plugins/goal/test/lifecycle.test.ts::replacement cannot inherit stale verifier completion`
- `plugins/goal/test/lifecycle.test.ts::failed verdict schedules once and duplicate settled does not verify again`

Proved: temporarily removed the clean-stop guard and ran the provider-error test;
it failed with expected paused, received complete. Restored the guard and reran
the Goal suite successfully.
