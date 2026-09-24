# Agent Note: Enforce the limits and promises pi-workflow advertises

Status: implemented
Partly-superseded-by: 2026-09-24-workflow-script-boundaries.md

## Problem

An independent design review of pi-workflow against four comparable products
(Step-Code, ZCode, grok-build, opencode) found the same shape eight times, and
each finding was reproduced in this repo's own code:

> the safety narrative is asserted more than implemented.

Six of the eight had a user-visible consequence; two were declarations that
described behavior the plugin does not have at all.

**A run with no budget was unbounded.** `runWorkflow` built
`new RunBudget(options.budget ?? {})`, and `RunBudget` with no limits skips the
admission check entirely. Concurrency was capped and the script was capped, but
the number of calls was not — the one axis a wide `parallel()` actually grows.
The README's "keep a run under about 15 agents" is a guideline for the model, and
a guideline is not a bound.

**`parallel()` was not "refused whole".** The README and `RunBudget`'s own
documentation both say a panel that would cross the limit is refused rather than
half-run. In fact `bridge.ts` admitted one agent per message, and the worker never
told it the panel's width, so a panel of ten against a budget of three admitted
three and refused seven. `RunBudget`'s doc comment described a contract nothing
implemented.

**A resumed call spent agent budget.** The orchestrator's cache branch is
commented "Cached before admission: a resumed call costs nothing". The host
admits a call *before* calling `options.callbacks.agent`, so the orchestrator
never got to decide; a reused call consumed a slot in the new run's budget. With
no default cap this was invisible; with one it makes resume fragile.

**Nothing bounded concurrent runs.** `RunRegistry.launch` rejected a duplicate
run id and nothing else, so N runs × a full panel of live children was possible.
The plugin caps the fan-out inside a run and left the same saturation reachable
from outside it.

**Two `developer` agents could edit one file.** `roles.ts` says "`developer` is
the single-writer role". Role isolation makes a planner and a reviewer read-only;
it does not make two writers take turns.

**Several declarations described behavior that does not exist.**
`WorkflowAgentOptions.readOnly` / `.writable` carried "A path outside every mount
is refused", while `ATTRIBUTION.md` records path mounts as deliberately cut and
nothing in `src/` read either field. `WorkflowMeta.roleSchemas` was documented as
"the cheap half of early validation" and had no consumer. Both read as
guarantees; neither was one.

**And the first pass at that fix was a spot fix, not a sweep.** It removed the
three the review happened to name and left three more of the same kind:
`WorkflowAgentOptions.agentType` (nothing reads it, and pi's CLI has no
`--agent` flag to wire it to, so it is a port artifact),
`WorkflowProgress.phaseIndex` (`phases[]` plus `currentPhase` already carry the
ordering), and the whole telemetry facility — `Journal.appendTelemetry`,
`WorkflowTelemetryRecord` and `paths.telemetryPath`, written by nothing and read
by nothing. Claiming a class of defect is closed requires enumerating the class;
fixing the reported instances is not the same thing, and the note said the class
was closed when it was not.

## Decision

Make each one true, or delete it.

- **A default agent cap.** `DEFAULT_MAX_AGENTS = 64` applies when the caller sets
  no agent budget (each axis defaults independently, so setting `budget` still
  gets the fan-out backstop). Generous on purpose: this is the runaway backstop,
  not the intended working size, and a legitimate large migration must not be cut
  off by it.
- **A panel preview.** The worker sends `admit` with the panel's width before any
  task runs; the parent runs `RunBudget.check(calls)`, a non-reserving test, and
  refuses the whole panel on failure. It does **not** reserve: each child still
  admits its own call, so a reservation here would count every task twice. The
  consequence is that a second panel can consume budget between the preview and
  the admits, so the preview narrows the window and the admits remain the bound.
- **`RunBudget.release` on a cache hit.** The slot the host admitted is handed
  back, which is what the cache branch's comment always claimed.
- **A cap on active runs.** `RunRegistry` takes `maxActiveRuns` (default 4,
  `PI_WORKFLOW_MAX_ACTIVE_RUNS` overrides), matching the per-run ceiling's own
  reasoning: a refused call is a failed agent, not a queued one.
- **A single-writer lock.** A declared write-capable role holds a mutex for its
  whole call. `isWritingRole` is deliberately false for `undefined`: an
  unprofiled agent is unrestricted rather than a writer, and treating it as one
  would serialize every agent in the common analysis-shaped script — removing the
  parallelism that is the feature.
- **The declarations with no consumer are removed, by sweep.** `readOnly`,
  `writable`, `roleSchemas`, `agentType` and `phaseIndex` are gone, the
  uncalled telemetry facility with them, and `ATTRIBUTION.md` records the
  removal rather than claiming the fields are kept. The set was determined by
  enumerating every field on the user-facing types in `core/types.ts` and every
  run-path field, then asking which had no reader — not by fixing the ones a
  report listed. JSON-Schema keywords (`required`, `enum`, `anyOf`, …) of
  `WorkflowJsonSchema` survive that sweep on purpose: they are read structurally
  by the validator rather than by name.

## Alternatives considered

**Reserve the panel's width up front instead of previewing.** Exact rather than
advisory, and it double-counts: a task may call `agent()` zero or many times, so
the width is an upper bound, not the number of admissions to come. Reserving the
bound would refuse panels the budget can afford.

**Make the default cap tight (15) to match the guideline.** The guideline is
advice for sizing work; a hard cap at the advice's number turns a documented
suggestion into a refusal for anyone who legitimately exceeds it. The backstop
belongs far above the target.

**Treat an unprofiled agent as a writer, since it can write.** Correct about
capability and wrong about cost: it would put every agent of every default script
behind one mutex, serializing fan-out to a crawl to protect against a collision
the script never asked to be protected from. Declaring a role is the opt-in.

**Keep `roleSchemas` and wire it as a default per-role output schema.** A real
feature, and a larger one than a defect fix: the parent only learns `meta` when
the script completes, so it needs a new early-`meta` message and a decision about
merging a role schema with an explicit one. Deleting the promise was the smaller
honest change; the feature deserves its own note if it is wanted.

**Leave the active-run cap to the user.** The plugin already decides that four
concurrent children is the safe default per run; leaving the number of runs
unbounded puts the same load back through a side door.

## Consequences

A run now has four bounds where it had two: concurrency, script wall-clock, agent
calls, and concurrent runs. `maxAgents` still sets an exact cap, and `budget`
still sets tokens; only the defaults changed.

Two behavior changes are visible. A run that would have used more than 64 agents
is now refused at the 65th — as a failed agent call inside the script, not a
truncation — and a fifth concurrent run is refused at launch with a message
naming `/workflows stop` and the environment variable. Both are the fail-closed
direction: the caller hears about the bound instead of paying for work nobody
budgeted.

A script that declares write roles loses writer parallelism. That is the point,
and it is opt-in: `parallel([developer, developer])` now serializes, while
`parallel([researcher, researcher])` — and any unprofiled panel — does not. The
control test pins that the readers still overlap, so the lock cannot silently
become a global serialization.

Removing the dead declarations changes the type surface. Nothing referenced
them, so the change is a compile-time narrowing only; a script that passed
`readOnly` was never protected by it, and one that passed `agentType` was never
configured by it. A caller who relied on any of them was relying on a field the
runtime ignored.

The panel preview is advisory against a race, not a fix for it. A script that
launches two wide panels whose combined width exceeds the budget can still see
the second one partially admitted and refused per call — which is the behavior
that existed before, now confined to that narrow case.

## Superseded

The `pipeline()` width preview and the claim that any panel's task count equals
its agent call count are superseded by `2026-09-24-workflow-script-boundaries.md`.
`parallel()` retains its task-count preview for the one-agent-per-task convention;
per-call admission remains the actual bound. The default cap, resume accounting,
run cap and writer lock decisions above remain in force.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — a run with no budget is bounded;
  a refused panel starts no child; two declared writers never overlap; two
  declared readers still do; a resumed call does not spend agent budget
- `plugins/workflow/test/host.test.ts` — the panel preview reaches the parent
  with the panel's width, a refusal starts no child, an affordable panel is
  previewed once and runs
- `plugins/workflow/test/registry.test.ts` — the active limit refuses a launch,
  frees a slot when a run settles, and the environment override falls back on a
  malformed value
- `plugins/workflow/test/roles.test.ts` — `isWritingRole` is false for an
  unprofiled agent and true only for a declared write-capable role
- `plugins/run-core/test/run-core.test.ts` — `check` previews without reserving
  and honours both axes; `release` gives a slot back and floors at zero

`237 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: six red runs, one per behavior change. Each fix was reverted in isolation
and the test below failed; restoring it returned the suite to green.

- **The `crypto`/`performance`/`setImmediate` names removed from the guard list.**
  Not this note's fix, but it shares the file: it failed
  `installDeterminismGuards > removes the capability globals`.
- **The default agent budget set to `null`.** It failed
  `workflow enforcement > a run with no budget still bounds its fan-out`, which
  is the defect stated directly.
- **The `admitPanel` call removed from `parallel()`.** It failed
  `script host concurrency > a panel wider than the remaining budget is refused
  before any child starts` — the panel ran instead of throwing — and
  `a panel the budget can afford is previewed once and then runs`.
- **`isWritingRole` forced to `false`.** It failed
  `workflow enforcement > two declared writers never hold the workspace at once`
  with both writers overlapping, while the readers' test stayed green — so the
  assertion is about the writer lock, not about concurrency being off.
- **`budget.release(1)` removed from the cache branch.** It failed
  `workflow resume > a resumed call served from the journal does not spend the
  new run's agent budget`, because the reused call consumed the only slot.
- **The `active.size >= maxActiveRuns` guard removed.** It failed
  `RunRegistry launch > refuses a run once the active limit is reached` and
  `> the limit frees up as runs settle`.

The deletions are pinned by `bun run typecheck` and by the fact that no consumer
existed to break: removing them produced no test failure, which is itself the
evidence that they were dead. That is the weaker half of this change and is
recorded as such rather than dressed up with a test that could not fail — which
is also why the first, partial pass at it went unnoticed for a whole round: a
deletion with no failing test is invisible in exactly the way it needs to be
visible.

The tests that do exist for this change are listed above and each has a red run.
The one for the authoring surface lives in the feature note
`2026-09-23-workflow-authoring-and-save.md`, since it is new behavior rather than
a repaired guarantee.
