# Agent Note: Bound a workflow child's shell command

Status: implemented

## Problem

A workflow child that may run `bash` — the `qa` role deliberately has it, so it
can run tests — has **no per-command timeout**, because pi's bash tool has none.
One hanging command inside a child (a broad `find`, a `cat` waiting on stdin, a
probe that never returns) consumes the entire per-agent budget. The executor then
kills the child at `agentTimeoutMs` (15 minutes by default), and the agent's work
up to that point is lost.

This is the same class of failure the auto-background work exists for, reappearing
one level down: the child is a full pi session, so its tools have the same gaps as
the parent's.

A hang inside a child was also a candidate explanation for a real stuck run whose
evidence was destroyed, and it could not be ruled out — which is the point of
bounding it rather than diagnosing it after the fact.

## Decision

Ship a small guard extension and load it into every child with
`--extension <path>`.

- On `tool_call` for `bash` or `powershell`, if `event.input.timeout` is absent,
  set it. `event.input` is documented as mutable for exactly this kind of patch,
  so no shell tool is reimplemented.
- Default 10 minutes: long enough for a real test suite, short enough that a
  stuck command fails **one tool call** while the agent still has budget to react.
  `PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS` overrides it; `0` disables the guard.
- **Only the builtin shell tool.** If another extension owns `bash` — `pi-bg-bash`
  backgrounds long commands and wakes the agent later — a hard timeout would
  defeat it. The guard checks `getAllTools()` and steps aside.
- **Only an absent timeout.** A command that chose its own keeps it.
- `childGuardPath()` returns the path only when the file exists, because passing
  `--extension` for a missing file would fail every child — worse than an
  unbounded shell.

Arg construction moved into an exported `buildPiArgs` so the guard flag, the tool
list, and the `--` separator can be asserted without spawning.

## Alternatives considered

**Remove `bash` from the `qa` role.** It is there so an agent can run the project's
tests, which is the role's whole purpose. Bounding the command keeps the
capability.

**Rely on `agentTimeoutMs`.** That is the behaviour the note is fixing: it bounds
the *agent*, not the command, so the agent dies instead of recovering.

**Reimplement the shell tool in the guard.** `pi-bg-bash` does that because it also
backgrounds, tracks, and re-delivers. For a default timeout, mutating the input is
the whole change.

**Drop `--no-session` so the child's transcript exists.** That is the evidence fix
from the sibling note, not the bound fix; a transcript diagnoses a hang after 15
lost minutes, a timeout prevents those minutes from being lost.

**Let the guard always inject, even over an extension's `bash`.** Simpler, and it
would silently turn `pi-bg-bash`'s "background and wake me" into "kill at 10
minutes".

## Consequences

A stuck shell command fails one tool call, and the agent continues with the error
instead of the whole agent being killed. A child that legitimately needs more than
10 minutes for one command must say so with its own `timeout` argument or raise the
environment variable.

The guard is a second extension entry point in the package, loaded into children
only. It is a real file path relative to the executor; a packaging scheme that
moved or omitted it would silently fall back to the unbounded default rather than
failing launches.

Every child loads one extra extension module, so child startup grows by the cost
of transpiling that file.

## Verification

- `plugins/workflow/test/child-guard.test.ts` — the default and override, the malformed-value fallback, injection only into an absent timeout, ownership detection (including a throwing registry), the two "steps aside" cases, and that pi loads the guard without errors
- `plugins/workflow/test/pi-executor-spawn.test.ts` — the guard flag is in the child argv with `--` last, it is omitted when unavailable, and the resolved path exists on disk

`202 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: two red runs.

- **The `--extension` push removed from `buildPiArgs`.** It failed
  `child argv > loads the guard extension and keeps the prompt after --`, so the
  test pins that the child actually receives the guard rather than that a path was
  computed.
- **`ownsBuiltinShellTool` made to always return true** (the guard claiming every
  shell tool). It failed
  `child guard extension > steps aside when another extension owns bash`, so the
  conflict-avoidance with `pi-bg-bash` is pinned rather than assumed.
