# pi-run-core

Background plugins share `SettledDeliveryQueue`: idle results send immediately;
busy results wait for `agent_settled`, each delivery is isolated so one failing
send cannot drop the rest of the batch, and callers clear the queue at session or
branch boundaries and recheck the result's origin inside the send callback.
`pi-workflow` uses it today; `pi-subagent` and `pi-bg-bash` keep their own queues
because their wake policies differ (steer at `turn_end`, quiet successes, result
revisions) — the shared part is the boundary rule, not the policy.

Shared run primitives for pi extensions that own a *run* rather than a *turn*.

A run is an execution with its own identity, budget, and snapshot: `pi-goal`'s
goal work run is the first consumer, and a workflow run is the second. This
package exists because these primitives are small, subtle, and each has already
been the site of a real bug — copied into two plugins they would drift, and the
drift would be silent.

This is a **library, not an extension**. It declares no `pi` manifest and
registers nothing. Consumers depend on it in one direction, which keeps every
plugin independently installable.

## What it provides

| Export | Purpose |
|---|---|
| `Admission` / `processAdmission` | Process-wide provider ceiling. Every spawned child agent takes a ticket; waiters are round-robin per run and the cap lowers itself on a throttle and recovers gradually. |
| `DeliveryLedger` | Durable offer/ack around a background result: a reload or branch switch replays an unacknowledged result once, and a message already in the transcript suppresses the replay. |
| `createPollGuard` | The bare-sleep parser and `tool_call` gate shared by workflow and bg-bash; each plugin supplies its live ids, reason and terminate policy. |
| `RunGuard` | Epoch × session staleness guard for async run work. Bump once on pause/clear/replace; every outstanding token dies at once. |
| `RunBudget` | Dual-axis, fail-closed spend limit. Tokens bound cost, agent calls bound fan-out; either exhausted stops admission. |
| `ActiveTimer` | Active-time accounting that survives pause/resume without dropping the sub-second remainder at each boundary. |
| `readTokenUsage` | One definition of what a message cost, so two plugins cannot disagree about when a budget ended. |
| `appendRunSnapshot` / `restoreLatestRun` | Branch-aware snapshot persistence with the "newest valid wins, malformed newest is absent" rule. |
| `ContinuationChannel` | Delivering a self-continuation back into the session, and knowing whether the turn that starts was yours. |
| `isolatedComplete` / `withDeadline` / `parseJsonReply` | A tool-free, isolated judgment call with a deadline the caller cannot forget. |
| `WorkItem` + `renderWorkSurface` | The shared vocabulary and renderer for "work that is still running" — one row format (`icon · kind · label · elapsed · metric`) so plugins cannot drift on what a live surface looks like. |
| `createWorkReporter` | The mount/tick/teardown lifecycle for a below-editor widget: claims the slot only while `live()`, repaints on a bounded `unref`'d interval, hands the slot back on the last settle. |
| `HostWork` / `formatHostWork` / `createHostWorkReporter` | RPC status text and publication independent of TUI rendering. Deduplicates, coalesces active progress, immediately publishes terminal states, and cancels timers with `clear()`. |

## Why each one is shared rather than local

**`Admission`** — a per-run semaphore bounds one run, and a per-plugin lane cap
bounds one plugin; neither bounds their sum. Four workflow runs with four agents
each against one provider account is sixteen live children, and the provider
answers a burst with refused calls that surface as failed agents. The ceiling is
a provider property, so it lives in one process-wide controller. It is kept on
`globalThis` under a symbol because a workspace can resolve two copies of this
package, and two module-level controllers would each believe they own the
ceiling. `PI_ADMISSION_MAX_CONCURRENCY` sets it (falling back to the older
`PI_WORKFLOW_MAX_CONCURRENCY`); the default is four.

**`RunGuard`** — a stale verdict can complete a goal the user already replaced,
and a stale continuation can start a turn for a goal that no longer exists.
These are correctness bugs, not races to tolerate. The guard is subtle enough
that a second copy would drift in the direction of *not* checking.

**`RunBudget`** — token budget alone does not bound a fan-out (a hundred agents
returning one line each cost nothing), and an agent cap alone does not bound
cost (one agent with a large context outspends a whole panel of small ones).
Both axes are needed, and the check is fail-closed: `admit()` throws, so a
caller cannot continue by ignoring a return value.

**`ActiveTimer`** — flooring each span independently drops up to a second per
boundary, so a goal that pauses often under-reports its own elapsed time. The
remainder is carried forward instead.

## Design notes

**Nothing here is a security boundary.** `isolatedComplete` isolates *judgment*
from the implementer's context — it does not sandbox a model. Extensions run
with full OS permissions, per pi's own security documentation; a run primitive
that claimed otherwise would be lying.

**`restoreLatestRun` treats a malformed newest entry as absent, not as a reason
to fall back.** Returning an older snapshot would silently restore a state the
session had already moved past.

**`WorkItem.label` is the stable task, never the live tool call.** A row that
republishes on every stream delta churns faster than a reader can parse —
live activity belongs in a surface the user opens on purpose, not in the
persistent one. `createWorkReporter` repaints rather than republishes for the
same reason.

**`ContinuationChannel.consume()` is per attempt, not per run.** A user
follow-up can arrive inside a run the extension started, and attributing that
turn to the extension is what causes a user's own output to be interrupted.

**`DeliveryLedger` separates durability from transport.** A custom message is
accepted by the host, not by the model, and the process can die between the two
events. The offer is the recovery record; the ack is the proof. The transcript
check is what makes the crash window harmless rather than a duplicate: a custom
message carrying `details.deliveryId` is already delivered even when the ack
never landed.

**Admission is a decision, not a counter.** A semaphore only counts; admission
also refuses to bypass a queue, holds a cooldown after a throttle, and lowers the
cap when the provider says it is saturated. The plugins' own caps remain: a
workflow's `maxConcurrency` decides how much of the shared budget one run may
occupy, and a subagent fleet cap decides how many lanes one plugin may keep.

## Install

`createHostWorkReporter` publishes only when `ctx.mode === "rpc"`. Pass the
origin context to `publish(work, ctx)` and call `clear()` at session/branch
boundaries. The default passive message transport never triggers a model turn;
Pi may defer it while streaming. `PI_RPC_PROGRESS_TRANSPORT=notify` opts into
host notifications. This library has no Paseo dependency.

Consumed as a workspace dependency:

```json
{ "dependencies": { "pi-run-core": "workspace:*" } }
```

## License

MIT.

`readTokenUsage` returns `null` when usage is missing or malformed, distinct
from an explicitly measured zero. A token-bounded goal stops on unknown usage;
unbounded goals can continue without inventing a spend value.
