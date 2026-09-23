# Agent Note: pi-workflow and pi-goal dual refactor — verification record

Status: implemented

## Problem

The goal was to refactor `pi-workflow` and `pi-goal` to their intended target
design in one effort. The decisions have their own notes; what none of them can
show is the claim that crosses both plugins — that the two refactors were
completed together against a shared library rather than each left partially
finished.

An earlier revision of this record carried stale figures and a
self-contradicting claim: it said "demonstrably working" while stating the
executor was "tested at its seams only". A record that overstates its own
evidence is worse than no record, because it is read as the authority on whether
the work finished.

## Decision

Keep one consolidated record of the delivered design and the verification output
at the tip of the refactor, with the numbers it actually measured.

**`pi-run-core`** (new, a library, not an extension) — the primitives both
plugins need and each had already gotten wrong once:

| Export | Why shared |
|---|---|
| `RunGuard` | A stale verdict can complete a replaced goal; a second copy would drift toward *not* checking |
| `RunBudget` | Token budget does not bound fan-out, agent count does not bound cost; both axes, fail-closed |
| `ActiveTimer` | Sub-second remainder must survive pause/resume or a long goal under-reports |
| `readTokenUsage` | One definition of what a message cost, or two plugins disagree about when a budget ended |
| `appendRunSnapshot`/`restoreLatestRun` | Branch-aware persistence; "newest valid wins, malformed newest is absent" |
| `ContinuationChannel` | Consumed per *attempt*, so a user turn is not mistaken for goal work |
| `isolatedComplete`/`withDeadline`/`parseJsonReply` | Tool-free judgment call whose deadline cannot be forgotten |

**`pi-workflow`** (new, five layers):

| Layer | Contents |
|---|---|
| `core/` | pure types, schema validation, stable hashing, the prefix-only resume rule |
| `host/` | the worker script host, structured-clone protocol, determinism guards |
| `runner/` | one-agent execution with schema repair, role→tool isolation, the pi subprocess executor |
| `runs/` | on-disk journal, the orchestrator, the **background run registry**, run listing |
| `pi/` | the `workflow` tool, `/workflows` command, and the launch/deliver wiring |

**`pi-goal`** — rebuilt on `pi-run-core`: `RunGuard`, `ContinuationChannel`,
`ActiveTimer`, `readTokenUsage`, `withDeadline`, and `restoreLatestRun` all come
from the library, and no local duplicate of any remains.

## Alternatives considered

**Rely on the per-decision notes and keep no consolidated record.** Each fix has
its own note, but no single note shows that both plugins were refactored against
a library they share, which is exactly the claim a reader needs when a `run-core`
change breaks one plugin and not the other.

**Record "compiles" and "the parts pass their own tests" instead of the process
chain.** That is the shape of the earlier revision that contradicted itself; the
refactor's risk lives at the seams (script → worker → orchestrator → spawned
process), so the record has to exercise them.

**Omit the known residue and the regressions found during the refactor.** A
silent gap is indistinguishable from a missing one; recording both is what keeps
a later reader from rediscovering them as new.

## Consequences

The refactor's cross-plugin claim is checkable in one run, which is what makes a
shared-library change observable: both plugins consume `pi-run-core`, so a
library change that broke one would break the other in the same session.

Five regressions surfaced during the refactor and are recorded rather than
quietly fixed, each with its own note:

| Regression | Caught by | Note |
|---|---|---|
| Goal killed a user's own turn on pause/clear | New provenance tests | `2026-09-23-goal-interruption-scope.md` |
| Script host deadlocked three ways | Host shutdown tests | `2026-09-23-workflow-host-hang.md` |
| Parameter properties broke extension loading under Node | `readPlan works under Node` | `2026-09-23-parameter-properties-under-node.md` |
| A resumed run was billed for work it reused | End-to-end resume test | `2026-09-23-resume-billing.md` |
| Resume rule was a hash lookup that searched past a divergence | Resume tests | `2026-09-23-workflow-core-port.md` |

Known residue, stated rather than hidden:

- `plugins/redact/src/engine.ts` still uses a parameter property. It is not
  reachable from an extension entry point today, so it does not break loading;
  the same fix applies if it becomes reachable.
- The HoH `iterate()` loop was deliberately not ported: it overlaps `pi-goal`'s
  verifier, which is already the stronger implementation (isolated model,
  detached context).

## Verification

Captured at the tip of the refactor.

### Typecheck — all six packages clean

```
pi-run-core   typecheck: Exited with code 0
pi-redact     typecheck: Exited with code 0
pi-jev-compact typecheck: Exited with code 0
pi-ace-search typecheck: Exited with code 0
pi-workflow   typecheck: Exited with code 0
pi-goal       typecheck: Exited with code 0
```

### Per package

```
run-core    21 pass  0 fail
workflow   153 pass  0 fail
goal        75 pass  0 fail
```

### Full workspace, one session

```
 538 pass
 0 fail
 1750 expect() calls
Ran 538 tests across 38 files.
```

The single-session run is the evidence for "both refactors completed together,
neither left partially unfinished": the two plugins share `pi-run-core`, so a
library change that broke one would break the other in the same run.

### Behaviour demonstrably working

Not "compiles", and not "the parts pass their own tests". The chain from a script
to a spawned process is exercised:

- `plugins/workflow/test/end-to-end.test.ts` runs a workflow script through the
  worker host, the orchestrator, and **real spawned agent processes**, and
  asserts the returned values, the accumulated token spend, that a parallel panel
  collects every result, and that a fully-resumed run spawns nothing
  (`cacheHits: 1`, `spentTokens: 0`).
- `plugins/workflow/test/pi-executor-spawn.test.ts` covers the executor's
  process handling against a fixture that speaks pi's JSON event stream: a normal
  run, a closed stdin, 500 drained progress events, an assistant error, the
  **timeout kill of a hanging child**, and the abort path.
- `plugins/workflow/test/plugin-wiring.test.ts` covers the design's background
  execution: the tool returns a handle without awaiting the run, the settled
  result is delivered back into the conversation, two concurrent runs each
  deliver their own result, a bad script name fails the tool call rather than a
  background run, and session shutdown stops active runs.
- `plugins/workflow/test/registry.test.ts` covers the registry contract:
  immediate launch, exactly-once settlement, a throwing work function becoming a
  failed run rather than an unhandled rejection, abort, and bounded history.
- `plugins/workflow/test/host.test.ts` kills a `while (true) {}` script within the
  timeout — the property that keeps a runaway workflow from taking the session
  with it.
- `plugins/workflow/test/loader.test.ts`, `plugins/goal/test/loader.test.ts` — pi
  loads both plugins and registers their tools and commands.
- `plugins/goal/test/lifecycle.test.ts` pins that a user's own turn survives
  `/goal pause`.
