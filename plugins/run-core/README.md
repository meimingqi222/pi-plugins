# pi-run-core

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
| `RunGuard` | Epoch × session staleness guard for async run work. Bump once on pause/clear/replace; every outstanding token dies at once. |
| `RunBudget` | Dual-axis, fail-closed spend limit. Tokens bound cost, agent calls bound fan-out; either exhausted stops admission. |
| `ActiveTimer` | Active-time accounting that survives pause/resume without dropping the sub-second remainder at each boundary. |
| `readTokenUsage` | One definition of what a message cost, so two plugins cannot disagree about when a budget ended. |
| `appendRunSnapshot` / `restoreLatestRun` | Branch-aware snapshot persistence with the "newest valid wins, malformed newest is absent" rule. |
| `ContinuationChannel` | Delivering a self-continuation back into the session, and knowing whether the turn that starts was yours. |
| `isolatedComplete` / `withDeadline` / `parseJsonReply` | A tool-free, isolated judgment call with a deadline the caller cannot forget. |

## Why each one is shared rather than local

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

**`ContinuationChannel.consume()` is per attempt, not per run.** A user
follow-up can arrive inside a run the extension started, and attributing that
turn to the extension is what causes a user's own output to be interrupted.

## Install

Consumed as a workspace dependency:

```json
{ "dependencies": { "pi-run-core": "workspace:*" } }
```

## License

MIT.
