# Agent Note: A reply to a parked lane holds a provider ticket

Status: implemented

## Problem

Admission (`2026-10-26-global-provider-admission.md`) gave every background
lane a ticket for its first turn and released it when the lane parked, so four
answered lanes cost the provider nothing. But `subagent_tasks reply` started
the lane's next turn **without taking a ticket back**: the launch path was
bounded, and the path that restarts the same work was not. Four parked lanes
answered at once ran four live provider turns with the ceiling holding none of
them — the hole admission exists to close, reopened by one tool call.

## Decision

A reply to a parked lane now acquires a fresh ticket and holds it until the
turn it started is done.

- The fleet-cap refusal stays **fast and first**: `registry.atCapacity()` is
  checked before the acquire. A reply that queued on the provider first would
  be stuck behind the very busy lanes whose cap it is about to exceed, and the
  existing "retry after a slot frees" contract would become a hang.
- After the acquire resolves, the lane is re-validated — it may have settled
  or been resumed while the reply queued — and `tryResume` still authoritatively
  refuses if the fleet filled in the meantime.
- The ticket is released on whichever comes first: `onTurnSettled`,
  `onIdleChange(true)`, lane settlement, an explicit `cancel`, or session end.
  All releases are idempotent; the cancel path is needed because a child that
  ignores its abort never reaches the settle callback, and the ticket belongs
  to the process, not the session.
- A failed `send` rolls the lane back to idle and releases the ticket, matching
  the pre-existing keepalive rollback.

Mid-turn replies (`steer` / `follow_up`) take nothing: the lane's original
turn is still the one occupying the provider.

## Alternatives considered

**Acquire after `tryResume`.** A queued reply would hold a fleet slot while
waiting on the provider — the same slot-holder-starvation shape the workflow's
writer lock is ordered to avoid, mirrored one level up.

**Refuse instead of queue when no ticket is free.** Launches queue, and a reply
is the same class of provider work; refusing only here would make the reply
strictly weaker than the launch that created the lane.

**Never release the launch ticket.** Simpler — one ticket per lane for its
whole life — but a lane parked for five minutes of keepalive would hold
provider capacity it is not using, and four answered lanes would block every
launch. That trade was already rejected when admission landed.

## Consequences

`reply` can now block briefly while queued for provider capacity, the same way
a launch can. The observable contract is unchanged: the reply is sent exactly
once, or a named refusal says why. The fleet cap and the provider ceiling now
both cover a lane's whole life, not just its first turn.

## Verification

- `plugins/subagent/test/admission.test.ts` — `a reply to a parked lane holds a provider ticket until the turn settles`
  and `cancelling a lane mid-reply-turn releases the reply ticket`.

Proved: releasing the ticket immediately after `replyTickets.set` made the
first test observe `inFlight: 0` instead of `1` after the reply (`1 fail`).
Moving the provider acquire ahead of the fleet check — before the ordering was
fixed — made
`plugins/subagent/test/lane-reply.test.ts::an idle reply cannot exceed the cap and can retry after a slot frees`
hang past its 5s timeout instead of returning the fast refusal. Both were
restored.
