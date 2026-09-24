# Agent Note: Goal usage and the single-task subagent

Status: implemented

## Problem

`pi-goal` originally saw only assistant messages in the parent session. A
foreground child and a background workflow each spent tokens outside that
stream, so `/goal --tokens` understated the cost. The workspace also had no
single-task delegation tool; workflow's script, journal and background result
were too much ceremony for one isolated task.

## Decision

`pi-subagent` exposes one named child task, foreground by default with an
optional background launch. Definitions come only
from the user's `~/.pi/agent/agents/*.md`; a built-in `explore` works without a
file and is limited to Pi's read-only inspection tools. A same-name user file
overrides it. Foreground answers and usage return in the invoking tool call;
background answers arrive as completion messages and usage settles against the
launching goal's lease. `pi-agent-runner` owns the shared process path and disables
goal, workflow and subagent registration in children, keeping fan-out one level
deep.

Model choice is call override, then user agent definition, then the parent
session's currently selected model. With no model override, the child also
inherits the parent's thinking level.

`pi-run-core` defines a versioned discovery channel and a small spend lease
interface, but holds no session state. `pi-goal` owns the service. The parent
`pi-subagent` or `pi-workflow` obtains a lease before launching a child, then
finishes it with cache-inclusive usage. Leases are idempotent. The goal checks
its identity and session before charging, waits for pending background work
before verification, and refuses a new delegation after its budget is reached.

Workflow's own `spentTokens` remains input plus output for its per-run budget.
The separate `goalTokens` figure includes cache reads and writes and excludes
reused journal results. This matches `pi-goal`'s existing message usage unit.
The goal budget is a soft upper bound: the plugin acts when usage is reported,
while a model response or child already in flight can overshoot it.

## Alternatives considered

- Reading only `tool_result.usage` would omit background workflow spend.
- A global run-core ledger would duplicate goal lifecycle and persistence.
- A subagent mode inside workflow would mix immediate single-task delegation
  with a background fan-out consent rule.
- Nested child schedulers would multiply work across independent process caps.

## Consequences

The three primitives remain distinct: goal owns progress and verification,
subagent answers one delegated task either in the current turn or on background
completion, and workflow coordinates many children in the background. A late
report cannot charge a replaced goal or
a different session. Pausing and resuming keeps the cost of an already launched
child but does not verify the stale work turn when that child later finishes.
The remaining bound is explicit: exact spend is known only after a child reports
it, and a session abandoned before a background result settles has no live goal
to receive that result.
