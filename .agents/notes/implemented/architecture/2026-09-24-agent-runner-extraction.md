# Agent Note: Extract the shared agent runner into pi-agent-runner

Status: implemented

## Problem

`pi-workflow` and `pi-subagent` each carried the same subprocess agent handling.
When `pi-subagent` was built, its executor was a trimmed copy of the workflow
runner: the same closed stdin, the same wall-clock kill, the same LF-split event
folding, the same child environment. That is a deliberately dangerous thing to
copy. The code has hung a real session three times — a piped stdin left open, an
undrained stdout, a kill that never fired — and each of those was fixed in one
place while the other copy kept the bug.

The copies had already diverged in small ways, which is how drift announces
itself:

- the workflow copy treated a child that exited non-zero with nothing on the
  event stream as a **success**, while the subagent copy treated it as a failure;
- the two produced different timeout messages;
- the child environment (the one-level fan-out rule) was written twice.

## Decision

The subprocess handling moves to a new library package, `plugins/agent-runner`
(`pi-agent-runner`), which — like `pi-run-core` — declares no `pi` manifest and
registers nothing. It holds exactly the code that was duplicated: the pi
invocation resolver, the generic executor (argv assembly, spawn, JSON event
folding, the timeout/abort kill, the evidence sink, the delegated-system-prompt
temp file), the usage type, and the scheduler-disable child environment
(`agentChildEnv` / `SCHEDULER_DISABLE_FLAGS`).

**Policy stays in the plugins.** The runner spawns a child and reports what it
saw; it does not decide what a result means. `pi-workflow` keeps `roles.ts`,
`child-guard.ts`, `agent-runner.ts` (schema repair and transport retry), and
`core/schema.ts`; its `runner/pi-executor.ts` becomes a thin adapter that
resolves the role, passes its guard extension path, and hands the runner a
structured-parse callback. `pi-subagent` keeps agent discovery, the `Task:`
prompt framing, and output truncation.

The two old copies are deleted, not left as shims:
`plugins/workflow/src/runner/spawn.ts` and
`plugins/subagent/src/{spawn,executor}.ts`.

One behavior is deliberately unified: **a non-zero child exit with no error event
is a failure for both.** The exit code is the last word, and reading it is what
makes a silent child diagnosable. This is a small widening of the workflow
behavior (it previously required a stream error) and is a fix, not a regression —
no caller depended on an empty success.

## Alternatives considered

**Keep the two copies and fix bugs twice.** Rejected: this is the status quo that
produced the divergence, and the process bugs are the expensive kind.

**Put the runner in `pi-run-core`.** Rejected: `pi-run-core` is run primitives —
guards, budgets, snapshots, token accounting. Child-process management is a
different concern, and folding it in would give the library two unrelated
responsibilities.

**Have `pi-subagent` depend on `pi-workflow`'s runner.** Rejected: plugins in
this workspace must install alone, so this would pull the workflow tool (and its
consent model) into every subagent install.

**A fully generic runner with a callback for every step.** Rejected as
over-abstraction: the shared surface is the process handling, and the differences
between the two consumers are exactly the policy that should stay out.

## Consequences

The process bugs have one home: a fix in the runner reaches both plugins, and the
one-level fan-out rule is one constant (`SCHEDULER_DISABLE_FLAGS`) instead of a
contract each spawner re-implements. The cost is a new library package to
version and publish, and one more node in each plugin's dependency graph.

The runner's public surface was kept minimal on purpose — no roles, no schema, no
guard — so the extraction did not freeze plugin policy into a shared API before a
third consumer exists. Tests moved with the code: the spawn-path and event-folding
tests now live in `pi-agent-runner`, while each plugin keeps the test that
composes the shared child environment with its own `*Disabled()` reader.
