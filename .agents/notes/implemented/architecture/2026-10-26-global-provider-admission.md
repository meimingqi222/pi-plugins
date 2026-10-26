# Agent Note: Admit live provider work once per process

Status: implemented

## Problem

Every concurrency ceiling in the workspace was local to the thing it bounded,
and none bounded their sum:

- `pi-workflow` gave each run a `Semaphore` of four, and allowed four runs to be
  live at once. Four runs × four agents is **sixteen** child pi sessions against
  one provider account.
- `pi-subagent` kept its own fleet cap of four busy lanes.
- `pi-bg-bash` allowed twenty background OS processes.
- The goal's planner and verifier make their own model calls.

Each README justified its own number by pointing at the same provider tolerance
("a burst becomes failed agents, not queued ones"), but multiplication turned
four safe bounds into one unsafe one. The failure was already possible before
this change: launch four workflows from one session and the provider refuses the
tail of each panel, which surfaces as failed agents rather than a queued run.

A second, quieter cost followed from the same shape: an agent waiting on its
run-local semaphore was recorded as `running`, so the live surface could not
distinguish "working" from "waiting for capacity".

## Decision

Add `Admission` to `pi-run-core` — one process-wide controller for live model
work — and route both spawners through it.

- `createAdmission({ ceiling })` owns a per-key bucket with a FIFO queue per
  `runId`. Waiters are granted **round-robin across runs**; a wide `parallel()`
  panel cannot fill the queue and starve every other run.
- `acquire({ runId, signal })` returns a ticket whose `release()` is idempotent.
  Aborting a queued waiter removes it and rejects; an abort while holding a
  ticket releases it in the caller's `finally` (and on the signal, if the child
  ignores cancellation) so a wedged process cannot hold provider capacity.
- `tryAcquire()` exists for latency-sensitive helpers: it refuses to jump a
  queue, so it cannot be used to bypass fairness.
- `observe(key, "throttled" | "succeeded" | "failed")` adapts the cap. A
  throttle multiplies it by 0.75 and starts a cooldown capped at 30 seconds;
  four successes recover one slot. This is the Step-Code semaphore's policy,
  which is the implementation family this workspace already ports from.
- The controller lives on `globalThis` under a symbol. A workspace can resolve
  two copies of `pi-run-core` (one per plugin dependency tree); two module-level
  controllers would each believe they own the ceiling and reproduce the exact
  multiplication this change removes.
- `PI_ADMISSION_MAX_CONCURRENCY` sets the ceiling, falling back to the existing
  `PI_WORKFLOW_MAX_CONCURRENCY` so an installed workspace that already raised it
  keeps its setting. Default remains four.

`pi-workflow` now acquires a ticket inside its run-local slot, after the writer
lock. `maxConcurrency` keeps its meaning as *this run's share*; the global
ceiling is separate. `pi-subagent` takes a ticket around every `executeSubagent`
call, including the session-less foreground path. A background lane releases its
ticket on the first idle/turn settle — a parked lane is awaiting a reply, not
occupying the provider, which is the same reason the fleet cap does not count
idle lanes. A `reply` that starts a later turn is serialized by the lane cap and
the user's own turn; re-admitting it would need a per-reply ticket lifecycle and
is deliberately out of scope. The lane cap and the fleet UI are unchanged — one
bound is structural, the other is the provider's.

## Alternatives considered

**Lower each plugin's own cap.** Four runs × two is still eight, and the
multiplier moves whenever a plugin adds a path. The invariant has to be stated
once, in the place that knows about every spawner.

**Make the run registry refuse the fourth run.** It bounds runs, not agents, and
a single run with `maxConcurrency: 4` plus a subagent fleet still overshoots. It
also turns a launch into an error where queueing is the better answer.

**Queue inside `agent-runner`.** The executor is the right choke point
mechanically, but it does not know a run id, so it cannot provide fairness across
runs; and goal's helper calls do not pass through it. Admission is a scheduling
decision, and scheduling needs an owner.

**Pass a model/provider key from every caller.** More precise in principle, but
most call sites do not know the model at admission time, and splitting one
account into several buckets multiplies the ceiling again. The API accepts a key;
all current callers use the default bucket.

## Consequences

The default worst case drops from sixteen live children to four. A run that
wants more than its share now waits instead of failing, and `workflow_status`
reports queued agents separately from running ones. The queue is per run, so one
run's panel order is preserved while runs alternate.

Goal planner and verifier calls deliberately do **not** take a ticket. They are
single, tool-free, 45-second-bounded judgment calls; putting them behind a
multi-minute agent queue would delay verification and burn the goal's run cap.
The overshoot is at most one helper call, and the goal lifecycle serializes them.

The adaptive cap is process state, not run state: one run's 429 lowers the cap
for every plugin, which is the point. It recovers only while someone is waiting,
so an idle process does not slowly inflate its own ceiling.

A workflow's own `runTimeoutMs` still measures wall-clock time from launch, so a
run queued behind other runs can reach the 30-minute cap without doing work.
Excluding queue time would mean teaching the script host's timer about
admission; the bound is generous enough that this is a follow-up, not part of
the admission change.

## Verification

- `plugins/run-core/test/admission.test.ts` — 7 tests: cross-run cap, round-robin
  fairness, abort removal, `tryAcquire` queue respect, throttle/cooldown/recovery,
  singleton identity and reset, throttle classification.
- `plugins/workflow/test/orchestrator.test.ts::two runs share one process-wide admission ceiling`
  — two runs, three agents each, injected ceiling of two.
- `plugins/subagent/test/admission.test.ts::a background lane waits for the
  process-wide provider ticket` — one ceiling, two lane launches; the second
  waits, and goes when the first parks idle.

Red-run proofs, each performed by reverting one piece and restoring it:

- Replacing the workflow `admission.acquire` with a no-op ticket made the new
  orchestration test fail with `Expected: 2, Received: 6` (`0 pass, 33 filtered,
  1 fail`). This is the multiplication the change removes, observed directly.
- Making `withAdmission` a pass-through in `pi-subagent` made the subagent
  admission test fail with `Expected length: 1, Received length: 2` (`0 pass,
  1 fail`). The lane cap alone allowed both; the global ticket is what held the
  second. Restored, the file passes.

Full suite after restoring: see `bun run test` / `bun run typecheck` results in
the change description.
