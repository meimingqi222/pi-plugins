# Agent Note: Normalize a killed command's exit code to null on Windows

Status: implemented

## Problem

`bun run test` failed on Windows in `plugins/bg-bash`:

```
startCommand > kills the process tree when the timeout elapses
error: expect(received).toBeNull()
Received: 1
    at plugins/bg-bash/test/run.test.ts:29:28
```

`RunOutcome.exitCode` is documented as "the process exit code, or null when the
process was signalled or never started". On Unix a process killed with `SIGKILL`
has no exit code, so Node reports `exitCode === null`. Windows has no signals:
`killTree` terminates the tree with `taskkill /F /T`, and the shell exits with a
real code — usually 1. The outcome therefore carried `exitCode: 1` even though
the run reported `timedOut: true` and had never produced a code of its own.

That was not only a test mismatch. `plugins/bg-bash/src/pi/format.ts` renders
the code in the job list (`[killed exit=1]`) and the job detail
(`Exit code: 1`), so a command that was killed by us acquired an exit code it
never produced. `outcomeReason` is unaffected: it tests `timedOut`/`aborted`/
`killed` before the code.

## Decision

Normalize the code at settlement, but only when this process is the one that
killed the command:

```ts
resolveResult({ exitCode: killed ? null : exitCode, timedOut, aborted, killed, spawnError });
```

`killed` is set by `kill()`, which is what the timeout, the abort signal, and an
explicit `bg_tasks kill` all route through, so one check covers all three. A
command that exits on its own keeps its real code.

## Alternatives considered

**Relax the test to accept a non-null code on Windows.** That leaves the
user-facing formatter printing `exit code 1` for a timed-out command, which is
the wrong story for the model to read.

**Pass the signal through `waitForTermination` and null the code when it is
set.** Windows never sets it, so this would not have caught the failing case at
all.

**Null the code whenever `timedOut` or `aborted` is true.** Almost the same, but
an explicit `kill()` is the third path and would have kept a stray code.

## Consequences

A killed command reports `exitCode: null` on every platform, so
`statusFromOutcome` and the formatters agree without a platform branch.

The trade-off is a narrow race: if the timeout fires in the same tick the
command exits with a real non-zero code, the code is replaced by `null`. The run
is already labelled `timedOut`/`killed`, so the code was not needed to explain
it.

## Verification

- `plugins/bg-bash/test/run.test.ts` — the `kills the process tree when the
  timeout elapses` case asserts `timedOut` is true and `exitCode` is null; the
  sibling cases pin that an explicit kill is `killed` and that a detached
  command keeps its real `exitCode: 0`.

Proved: before the change, `bun test plugins/bg-bash/test/run.test.ts` ran
`4 pass, 1 fail` with `Received: 1` at the `toBeNull()` assertion; after it,
`5 pass, 0 fail`.
