# Agent Note: Headless agent children disable pi-bg-bash auto-backgrounding and still bound the shell

Status: implemented

## Problem

Two cooperating gaps made a delegated child's shell commands both unbounded and
unanswerable:

- Workflow and subagent children load ambient extensions, including
  `pi-bg-bash`. In a headless `-p`/rpc child there is no live session for a
  backgrounded job to wake: a `qa` agent's 45-second test run crossing the
  30-second auto-background threshold returned a job id that never delivered
  its result, and the job died with the process.
- The workflow child guard (`plugins/workflow/src/runner/child-guard.ts`)
  injected its default shell timeout only when `bash`/`powershell` was the
  builtin tool, stepping aside for any extension-owned shell — including
  bg-bash, whose rationale ("it wakes the agent later") does not hold in a
  headless child. So with bg-bash present, child commands were unbounded.

## Decision

- `pi-agent-runner`'s `agentChildEnv()` additionally sets
  `PI_BG_BASH_THRESHOLD=0`, carried in a new exported `HEADLESS_CHILD_ENV`
  constant — deliberately separate from `SCHEDULER_DISABLE_FLAGS`, since it is
  an ambient-extension setting, not a fan-out guard. The env value has the
  highest precedence in bg-bash's threshold resolution, and `0` disables only
  *automatic* backgrounding (explicit `background: true` still works). Both
  transports pick it up because both already call `agentChildEnv`.
- The child guard now injects its default timeout when the shell tool is
  builtin **or** when the registered tool's `parameters` schema declares a
  `timeout` property — which bg-bash's does, with the same seconds semantics.
  An extension shell without such a property is still left alone: guessing a
  foreign tool's parameter shape is the worse failure.

## Alternatives considered

- **Add `PI_BG_BASH_DISABLE`-style switch to bg-bash instead of reusing the
  threshold.** A new flag means editing bg-bash's config resolution and keeping
  two switches consistent; `PI_BG_BASH_THRESHOLD=0` already means exactly
  "never auto-background" and wins precedence without new code.
- **Keep stepping aside for bg-bash.** Preserves the interactive-session
  assumption in an environment where it is false — backgrounded jobs there are
  write-only.
- **Detect bg-bash by name/source** rather than by schema. Name-matching is a
  list that rots; the `timeout` property *is* the contract the injection needs.

## Consequences

A delegated child's long shell command blocks normally and is bounded by the
child guard's default (or the command's own) timeout — one tool call fails and
the agent recovers, instead of losing the run. The schema check means any
future shell extension that declares `timeout` opts into the same bound
automatically; one that does not is untouched, as before.

## Verification

- `plugins/agent-runner/test/child-env.test.ts` — "disables pi-bg-bash's
  auto-backgrounding in the headless child" pins `PI_BG_BASH_THRESHOLD=0`, and
  the env-shape test now includes `HEADLESS_CHILD_ENV`.
- `plugins/workflow/test/child-guard.test.ts` — "injects into an extension
  shell that declares a timeout parameter" and "steps aside when another
  extension owns bash without a timeout parameter".

Proved: with the three source files stashed (`executor.ts`, runner `index.ts`,
`child-guard.ts`), `bun test plugins/agent-runner/test/child-env.test.ts
plugins/workflow/test/child-guard.test.ts` failed — 14 pass / 2 fail / 1 error
(the `HEADLESS_CHILD_ENV` import resolving to nothing, the threshold assertion,
and the schema-injection case). After restoring, 18 pass / 0 fail.
