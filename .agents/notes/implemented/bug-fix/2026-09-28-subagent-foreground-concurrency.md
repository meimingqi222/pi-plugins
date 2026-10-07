# Agent Note: Foreground subagent calls share the fleet's concurrency cap

Status: implemented
Partly-superseded-by: 2026-10-07-subagent-reply-admission.md

## Problem

The cap of four counted only background lanes. Foreground `subagent` calls
were "a lane too" for observability but not for admission control — and pi
runs a tool batch in parallel, so a single turn issuing N blocking
`subagent` calls spawned N children at once, unbounded.

## Decision

**The cap counts busy lanes of both kinds; a foreground call past it waits
FIFO instead of being refused.**

- `LaneRegistry.busyCount()` counts running, non-idle lanes of either kind
  plus slot *reservations* — the gap between "a queued call was granted a
  slot" and "its lane exists". A reservation is counted immediately so two
  calls waking in the same tick cannot both see a free slot.
- The limit resolves from `PI_SUBAGENT_MAX_CONCURRENCY` (positive integer,
  else 4) in `resolveLaneLimit`.
- `acquireSlot(signal)` grants a reservation immediately when a slot is
  free, else parks FIFO; each freed slot — a busy lane settling or going
  idle — wakes exactly the head waiter, which is how the queue stays FIFO.
  An abort while queued resolves `false`: the tool returns the same
  cancelled-shape result as a launch aborted up front, and spawns nothing.
  One `onUpdate` ("waiting for a subagent slot (N busy)") is emitted when
  the call finds the fleet full.
- A background launch is still refused, with the message generalized to
  "subagents" since foreground calls now count.
- A reply re-activating an idle lane is always allowed — the fleet may
  transiently exceed the cap, which beats refusing a reply to a lane that
  already exists.
- The session-less direct path stays uncapped: no session means no fleet.

## Alternatives considered

- **Refuse foreground calls like background ones.** A refused blocking call
  is a failed tool call in the middle of the session's own turn — the model
  cannot "check back later" on a lane it never got. Waiting matches what a
  blocking call is.
- **Semaphore in the tool layer instead of the registry.** Would duplicate
  the idle/settle signals the registry already owns, and would still need
  the reservation trick to stay race-free across a synchronous launch check.
- **Count only foreground lanes against a separate cap.** Two limits for
  one resource (children this session spawned); the fleet is the resource,
  so the cap is fleet-wide.

## Consequences

A tool batch of any width degrades to N-at-a-time rather than spawning N
children. `busyCount` includes reservations, so `atCapacity` is accurate the
instant a slot is promised — no double-grant race between `acquireSlot` and
`launch`. The pre-`acquire` `onUpdate` is advisory: a slot freed between the
check and the queue may make the message slightly stale, which costs one
harmless progress line.

## Superseded

The idle-reply exception is replaced by
`2026-10-07-subagent-reply-admission.md`: an idle reply must reclaim capacity
before starting a new turn. Foreground FIFO admission, reservations, and the
shared busy-lane cap still hold.

## Verification

- `plugins/subagent/test/lane.test.ts` — the rewritten foreground-slot test,
  `acquireSlot` FIFO/wake/abort coverage.
- `plugins/subagent/test/lane-reply.test.ts` — "foreground concurrency":
  a third call waits with a "waiting for a subagent slot" update while only
  two executor invocations exist; a queued abort returns cancelled with no
  spawn; a background launch is refused while two foreground lanes are busy.

Proved: with `plugins/subagent/src/lane.ts` and `plugins/subagent/src/index.ts` stashed, the concurrency tests
fail — a third call spawned immediately, the queued abort never surfaced,
and the background launch reported running instead of refused
(`11 pass, 12 fail` across the two files; the same stash also removed the
earlier turn-settle work, so those tests failed too). Restored:
`23 pass, 0 fail` in the two files, `116 pass, 0 fail` across the plugin.
