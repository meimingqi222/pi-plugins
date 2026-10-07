# Agent Note: Idle replies reclaim a fleet concurrency slot

Status: implemented

## Problem

Idle lanes released their concurrency slot but could always accept a new
prompt. Once another launch occupied that slot, replying to the idle child
exceeded the configured fleet cap. The earlier explicit exception made a
resource limit ineffective under repeated replies.

## Decision

The registry atomically marks an idle background lane busy only when capacity
is available and no foreground waiter has priority. Refuse an idle reply at
capacity before sending anything. On a failed stdin send, restore the original
idle timestamp and keep its existing keepalive timer. A successful reply clears
the timer. Mid-turn steer and follow-up retain their existing busy slot.

## Alternatives considered

- Continue allowing replies above the cap: breaks the fleet-wide resource bound.
- Wait inside the reply tool: requires coordinating child expiry, cancellation,
  and duplicate replies while queued; explicit refusal permits a safe retry.
- Count idle processes as busy: four answered children would block all new work
  throughout their keepalive window.

## Consequences

The model must retry a refused idle reply after capacity frees. The prompt is
not buffered or sent on refusal. Existing answers, idle timestamps and keepalive
remain available. Foreground reservations cannot be stolen by a reply.

## Verification

- `plugins/subagent/test/lane-reply.test.ts::an idle reply cannot exceed the cap and can retry after a slot frees`
- `plugins/subagent/test/lane-reply.test.ts::an unsuccessful idle reply preserves its idle slot and keepalive`

Proved: before the fix, the capacity regression received "Reply sent" where
it expected the four-child capacity refusal. The failure is saved in
`.agents/notes-evidence/2026-10-07-subagent-lifecycle-red.txt`. After the fix,
the refusal/retry and failed-send rollback tests pass; the focused two-file
suite has 42 pass, 1 skip, and 0 fail.
