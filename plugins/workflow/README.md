# pi-workflow

Structured multi-agent workflows for pi. A script fans work out across isolated
agent contexts, collects structured results, and can resume from a journal
instead of paying for the same calls twice.

## Why a workflow at all

A goal and a workflow answer different questions:

| | Goal (`pi-goal`) | Workflow |
|---|---|---|
| Question | *keep working on this over time* | *do this one large piece of work now* |
| Shape | one conversation, many turns | many isolated contexts, one script |
| Context | your session | N separate contexts, so redundancy never enters the main conversation |
| You see | every turn | a progress view |
| Cost driver | turns | agent calls and tokens |

A workflow is worth its cost when the work is **both wide and structured**:
reviewing 200 files, migrating a few hundred call sites, running a panel of
reviewers over a diff. For a single lookup or a one-file edit it is strictly
worse than a direct tool call, and the tool's own guidelines say so.

Runs belong to the session and history branch that launched them. Leaving that
session or branch stops its live runs; late results are not posted into the new
conversation. A harness failure wakes the originating conversation with its
error so the agent can respond instead of waiting for a result that cannot arrive.
Results that settle during another agent turn are handed to Pi at
`agent_settled`, when a `followUp` can safely start a turn. Idle results are
delivered immediately. Results settling after the launching
session has been left are discarded.
A failure in goal spend reporting is surfaced without suppressing the workflow
result or preventing session cleanup.

## The surface

- **`workflow` tool** — takes exactly one of `script` (inline JavaScript),
  `scriptPath` (a file inside the project), or `name` (a saved workflow in
  `.pi/workflows/saved/`, project or user level). Optional `args`, `budget`,
  `maxAgents`, `maxConcurrency`, `agentTimeoutMs` (per agent), `runTimeoutMs`
  (whole run, default 30 minutes), `resumeFromRunId`.

  Concurrency is capped by a **provider ceiling: 4 live agents by default**, set
  with `PI_WORKFLOW_MAX_CONCURRENCY`. `maxConcurrency` can only *lower* that
  ceiling; a request above it is clamped rather than refused, and a burst beyond
  what the provider tolerates becomes failed agents rather than queued ones —
  which is why the default is the safe one rather than the fastest one.
- **`workflow_status` tool** — reports what active runs are doing: phase,
  agents running and their elapsed time, tokens, age of the last progress event,
  and whether a per-agent timeout bounds them. `/workflows` renders the same
  text for the user: one liveness surface, two callers, so the two can never
  disagree about a run.
- **`/workflows` command** — shows the active runs **and** the recent history
  together, then saved workflows. `/workflows <runId>` reports one run in full,
  `/workflows live` opens a panel that re-renders while it is open (TUI only;
  elsewhere it degrades to the same listing), `/workflows stop [runId]` aborts
  one or all, and `/workflows save <name> [--user]` promotes the newest run's
  script into the saved set so `workflow({ name })` runs it from then on.
  Promotion copies the run's own persisted `script.js` and refuses an existing
  name, so a hand-edited saved workflow is never replaced silently.
  Each row states the outcome as a word (`completed`, `partial`, `failed`,
  `aborted`, `unfinished`, `empty`), how many calls produced a result versus
  failed, tokens, and how long it ran — because the question a reader has is
  "which of these worked", not "how many agents ran".
- **A footer entry while anything runs** — `wf 3m 12s · 1-repos · 3 running`
  occupies one footer slot, ticking once a second, and is handed back
  (`setStatus(key, undefined)`) the moment the last run settles. A run lasts
  minutes and the notification that announced it scrolls away, so without this
  the normal experience is a session that looks idle while four agents work.
  The ticker exists only between the first launch and the last settlement, and
  it is unref'd, so a one-shot mode is never held open by a footer nobody can
  see.
- **Opt-in by rule, not by shape.** The tool's `promptGuidelines` require an
  explicit opt-in ("ultraloop", a direct request, a saved name, or a skill).
  A task that merely *looks* large is not consent — this is the cheapest
  defence against the most expensive mistake.

## A run is launched, not awaited

`execute` starts the run in a `RunRegistry` and returns a handle immediately;
the settled result is delivered back into the conversation as a
`workflow-result` message. A workflow exists for work too large for one turn —
a tool that blocked the turn would hold the conversation hostage for the whole
run. `/workflows` is the user's progress surface, and the footer entry is what
makes a run visible without asking.

The result message contains a short run summary followed by the answer with
its original line breaks. In the TUI it is compact by default and expands to
render the full answer as Markdown. The run record remains in message details
for programmatic inspection; structured answers are pretty-printed as JSON.

Because nothing forces the turn to end, a model with nothing else to do will
often hedge by polling: `bash: sleep 30`, again and again. Two things close that
gap.

- **`workflow_status`** answers the question the model is really asking — *is
  this alive?* — with phases, running agents and their age, tokens, time since
  the last progress event, and whether a cap bounds them. Age alone is not
  proof of a stall (a long agent call is silent between start and finish), so
  the status reports the bound instead of guessing at a verdict.
- **A poll guard.** A bare `sleep` while a run is active is blocked and the
  batch is terminated, which ends the turn cleanly: the model is woken by the
  settled result instead of spinning. A sleep with a purpose
  (`sleep 5 && npm test`) is untouched, and the batch rule means a poll batched
  with real work does not stop that work.

Progress is stored on the registry record rather than streamed through
`onUpdate`, because `onUpdate` is only live while `execute` runs and `execute`
returns at once.

## The script environment

Scripts run in a **worker thread** (`node:worker_threads`), not in the pi
process: `terminate()` interrupts a synchronous `while (true) {}`, which no
in-process guard can do, and a memory cap keeps a script from growing the
parent's heap. A subprocess was considered and rejected — it needs a second
interpreter and broke under Bun; the worker gives the property that matters
(killability) on both Node and Bun.

Inside the script:

| Global | Behaviour |
|---|---|
| `agent(prompt, options)` | one isolated pi subprocess; `options` may carry `label`, `schema`, `toolProfile`, `model`, `effort`, `phase` |
| `parallel(tasks)` | barrier fan-out over task functions |
| `pipeline(items, ...stages)` | per-item flow with no barrier between stages |
| `phase(title)` / `log(message)` | progress reporting |
| `budget` | `{ total, spent, remaining }` for the run's token budget |
| `args` | the tool call's `args` |

Determinism guards are installed in the worker: `Date`, `Math.random()`,
`Intl.DateTimeFormat`, `crypto` and `performance` throw, and `process`,
`require`, `fetch`, `setTimeout`, `setInterval` and `setImmediate` are
unavailable. Pass timestamps through `args`; vary prompts by index.

### Failure semantics — the asymmetry that costs a run

A failing agent call behaves differently depending on where it is awaited, and a
final step written outside a barrier turns every earlier degradation into a
lost run:

| Shape | One task's failure becomes |
| `parallel()` / `pipeline()` | **`null`** — siblings keep their work and the run continues |
| a direct `await agent(...)` | **a thrown error** — the script fails, the run is `aborted`, nothing is returned |

This is deliberate: a barrier must not discard its siblings' results, while a
value the script is *about to use* must not silently become null. The consequence
for script authors is that a synthesis step placed outside the barrier aborts
the run even when every other phase degraded cleanly. Two ways to keep a run
usable:

```js
// either: hold the last call to the same contract as the rest
const report = (await parallel([() => agent(prompt, opts)]))[0];   // null on failure
// or: decide what a failure means
let report = null;
try { report = await agent(prompt, opts); } catch { /* report the gap */ }
```

An agent call that fails inside `parallel()` is still journalled as `failed`, so
nothing is hidden by the null — the run summary reports the count and the last
error regardless.

Nothing here is a security boundary — pi extensions run with full OS
permissions, and the script is written by the model in your own session. Do
not run workflow scripts you did not ask for.

## Roles and write isolation

`agent()`'s `toolProfile` resolves a role to a tool list, enforced by passing
`--tools` to the child pi process rather than trusting the prompt:

| Role | Tools |
|---|---|
| `planner`, `reviewer`, `researcher` | read-only (`read`, `grep`, `find`, `ls`) |
| `qa` | read-only + `bash` (can run tests, cannot edit) |
| `developer`, `worker` | read-only + `edit`, `write`, `bash` |

Write permission is a *role* property, not a path whitelist: a planner and a
reviewer never write, so two of them cannot collide, and only a developer
does. Path-level ACL was considered and cut — the role split is the 80%.

That split stops a planner from writing at all; it does not stop two
`developer` agents in one panel from editing the same file. A declared
write-capable role therefore holds a **single-writer lock** for its whole call,
so the writer role means what it says. Only a *declared* role takes the lock: an
agent with no `toolProfile` is unrestricted rather than a writer, so declaring
no role costs no parallelism.

### A structured reply is parsed at the boundary

A model's reply is text. It is parsed where it enters — in the executor — and a
value is only returned when it parses, so that:

- a reply wrapped in a ` ```json ` fence (the common habit) is unwrapped rather
  than rejected as a string;
- a genuinely malformed reply is reported as **not JSON**, not as a schema type
  error, which is what a repair attempt can act on;
- `result.value` means a parsed value, never raw text.

The retry loop feeds the validation error back with a bounded excerpt of the
previous reply, and caps the attempts (`retries` per call, 3 by default). Attempts
are charged: a failed call reports the tokens it spent, because a schema repair
is a real — often the most expensive — model call.

### A lost connection is retried once, but only where re-running is safe

A child that dies of a transport failure produced **nothing**, and losing one
answer degrades a run that has already cost minutes. So a transport-class failure
(the provider's own wording: `Upstream stream ended before terminal chunk`,
`Connection error.`, `socket hang up`, …) is re-run once — re-asking the original
question, not with a schema-repair block, because the model never answered the
first ask.

It applies **only to a provably read-only role** (`planner`, `reviewer`,
`researcher`). A child that may have written before it died cannot be re-run
blind: a duplicated edit or a second `git commit` is worse than a missing
answer. `qa` does not qualify either — it cannot edit, but it can run a shell,
and a shell can write anything. That gate is not overridable; the budget
(`PI_WORKFLOW_TRANSPORT_RETRIES`, default 1, `0` disables) only tunes how many.

Failures that repeating would reproduce are excluded on purpose: the run's own
`agentTimeoutMs` (a re-run hits the same cap with the same bill), quota and
routing errors (`429`, no available route), provider saturation
(`concurrency reached`), and schema or policy failures — those are answers, not
lost connections.

The boundary is tested with a real subprocess

The `end-to-end` and `structured replies` tests spawn the fixture, not a fake
executor. That is deliberate: a wiring bug that passes every unit test — the
executor silently not parsing, so every structured call failed with
`$ must be object` — can only be caught by driving the real path where the two
modules meet.

## A child process is told it is not the user's session

Ambient extensions load in a workflow child, since the spawn does not pass
`--no-extensions` (a child may be asked to use one). So a plugin that schedules
work for the user's session has to be told this is not one, or it will inject the
parent's objective into a context that cannot act on it and bill the parent's
budget for the tokens.

The child environment comes from `pi-agent-runner`'s `agentChildEnv()`, which
sets `PI_GOAL_DISABLE=1` (read by `pi-goal`), `PI_WORKFLOW_DISABLED=1` (read by
this plugin) and `PI_SUBAGENT_DISABLE=1` (read by `pi-subagent`, when installed),
so **fan-out is one level deep.** Without them a child — which loads ambient
extensions like any other pi process — would register the `workflow` and
`subagent` tools and be free to start a run or a delegation of its own,
multiplying concurrent provider streams past the account limit. Step-Code names
the same failure for its own children; the recursion bound belongs in the spawn
environment because there is no core mechanism to declare it. Keeping the three
switches in one constant is what makes a fourth scheduler a one-line change
rather than a hunt through every spawner.

### A child's shell is bounded

A `qa` agent may run `bash` (so it can run tests), and pi's bash tool has no
default timeout. One hanging command — a broad `find`, a `cat` on stdin — would
then consume the entire per-agent budget and lose the agent's work. Every child
therefore loads a small guard extension (`src/runner/child-guard.ts`) that gives
the builtin shell tool a **10-minute default timeout**, injected by mutating the
`tool_call` input so no shell tool is reimplemented.

- `PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS` overrides it; `0` disables the guard.
- A command that set its own timeout keeps it.
- The guard steps aside when another extension owns `bash` — `pi-bg-bash`
  backgrounds long commands rather than killing them, and a hard timeout would
defeat that.

This bounds an agent at 10 minutes per command instead of the whole per-agent
cap (15 minutes by default), so a stuck command fails one tool call and the agent
can recover.

## Budget, journal, resume

When a workflow starts inside an active `pi-goal` work run, its parent plugin
reports cache-inclusive child usage to the goal on settlement. The workflow's
own `spentTokens` and `budget` still use input plus output; they exclude cache
reads and writes. Goal accounting uses a different, cache-inclusive total so it
matches the goal's message usage. Both budgets react to reported usage, so a
running child may cross a token limit before it settles.

- **Dual-axis fail-closed budget** (`pi-run-core`'s `RunBudget`): tokens bound
  cost, agent count bounds fan-out. Admission is checked *before* an agent
  starts, so a refused call costs nothing. `parallel()` previews its task count
  before starting any task (use it for one-agent-per-task panels); this refuses
  a panel whose declared width exceeds the limit. Arbitrary task functions may
  call zero or multiple agents, so this preview is not a reservation or an
  exact count. `pipeline()` cannot preview agent calls from arbitrary stages;
  each actual `agent()` call is admitted separately, and a refused stage yields
  `null` for that item. Concurrent panels can also consume budget between a
  preview and their calls; per-call admission remains the hard bound. A resumed
  call served from the journal releases its admitted slot, since it did no work.
- **A default agent cap.** A caller who sets no budget still gets a cap of 64
  agent calls, because "unbounded unless you ask" contradicts every other bound
  here. The number is a runaway backstop, deliberately far above the ~15 the
  guidelines ask for; `maxAgents` sets an exact cap. Tokens stay unbounded
  unless `budget` is given.
- **A cap on active runs.** Four runs may be live at once
  (`PI_WORKFLOW_MAX_ACTIVE_RUNS` raises it), because each active run holds up to
  a full panel of child sessions. `/workflows stop` frees a slot.
- **Journaled calls.** Every agent call is hashed and appended to
  `.pi/workflows/runs/<runId>/journal.jsonl` — **including failures**, with the
  error. A failed call is never *reusable*, so resume stops at it, but recording
  it is what stops a run whose calls all failed from leaving a directory that
  looks untouched.
- **Durable progress.** `.pi/workflows/runs/<runId>/progress.json` holds the
  latest snapshot (phase, agents, tokens, last event), written atomically and
  throttled. `/workflows` lists it and `workflow_status` reads the live copy, so
  a run can be checked while it is alive and diagnosed after it is gone.
- **Per-agent evidence.** Each child's raw JSON event stream is appended to
  `.pi/workflows/runs/<runId>/agents/<agentId>.jsonl`. The children run with
  `--no-session`, so without this a hung agent leaves nothing to read; a timeout
  names its evidence file in the error.
- **Prefix-only resume.** `resumeFromRunId` reuses the journaled prefix and
  executes live from the first divergence onward. Once resume is disabled it
  never re-enables — a lookup that kept searching past a divergence would
  silently mix an old execution into a new one. A cached call is billed to the
  earlier run, not this one, and is recorded in the *new* run's journal as
  `cached`, so a run resumed from a resumed run stays resumable. A reused call
  also releases the agent-budget slot it was admitted, since it did no work.
- **The budget bounds one execution, not a chain.** A resume is a new run with
  its own `budget` argument, and the parameter means what it says; so a resume of
  a run that already spent its token budget gets a fresh one, and the total across
  a chain can exceed any single call's number. Carry a budget across a chain
  instead, and the counters have to be persisted per run — the budget's `restore`
  is the seam for that, and it is deliberately unwired.
- **The budget reports what it did.** Two facts beyond `spentTokens`, both the
  budget's own: whether a token limit was crossed after admission (`overspent`,
  since the limit is passive and a run can cross it and still finish) and whether
  it refused work (`refused`). Both are named in the result's `stopReason`, and a
  run the budget stopped settles with a progress status of `budget_exceeded`
  rather than a bare `failed`.
- **A truncated journal is truncated, not repaired.** Reading stops at the
  first unparseable line and the first sequence gap; only a verified
  contiguous prefix is replay input.

## Layout

| Module | Contents |
|---|---|
| `core/` | pure contracts: types, JSON-Schema/TypeBox validation with `stripUnknown`, stable hashing, the `ResumeLog` resume rule — no fs, no process, no pi import |
| `host/` | the worker script host: NDJSON-free structured-clone protocol, determinism guards, worker entry |
| `runner/` | one-agent execution with schema repair, role→tool isolation, the pi subprocess executor, the pi invocation resolver |
| `runs/` | the on-disk journal, the orchestrator, the background run registry, run listing |
| `pi/` | the `workflow` tool, the `/workflows` command, the footer entry and live panel, script source resolution |

`core/` being pure is what lets the parts with real logic be tested directly;
the disk format lives in `runs/` for the same reason.

## Deliberately not built

- **HoH `iterate()`** (Planner→Developer→QA loop) — overlaps `pi-goal`'s
  verifier, which is the stronger implementation (isolated model, detached
  context). With roles in place, the loop is `agent()` calls in a script.
- **ZCode-style compiler** — ~20k lines for compile-time checking; a runtime
  schema mismatch is caught on the first agent call and retried with the
  errors fed back.
- **Path-level ACL** — see above.
- **Cross-process resume** — a killed pi loses active runs; the journal on
  disk is the recovery story (`resumeFromRunId`).

## Provenance

The core is ported from Step-Code's workflow runtime (MIT). See
[ATTRIBUTION.md](ATTRIBUTION.md) for the file mapping and every deliberate
divergence.

## License

MIT.
