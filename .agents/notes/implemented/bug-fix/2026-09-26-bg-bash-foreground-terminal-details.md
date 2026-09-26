# Agent Note: Report terminal details for foreground bash results

Status: implemented

## Problem

Foreground bash commands returned `details` built from the job record while its
status was still `running`. The command had completed successfully, but the
persisted tool-result metadata disagreed with its content and the terminal
state that callers expect.

## Decision

Before building the successful foreground result, record its outcome through
`JobRegistry.finish`. This sets the terminal status, exit code, and end time on
the same job used to format the result. Then remove the job from the registry
as before; the returned details are derived from the now-settled job.

## Alternatives considered

**Set only `job.status`.** This would fix the visible status but leave the exit
code and duration metadata inconsistent with a completed job.

**Special-case the returned details.** This duplicates the registry's outcome
mapping and risks diverging from background-job status semantics.

## Consequences

Successful foreground results now report a terminal status, exit code, and
measured duration. The foreground job remains untracked after the tool call,
and non-zero/timeout error behavior is unchanged.

## Verification

- `plugins/bg-bash/test/bash-tool.test.ts` — `returns terminal details for a completed foreground command`

Proved: before the fix, `bun test plugins/bg-bash/test/bash-tool.test.ts` failed:
expected `status: "exited"` and `exitCode: 0`, received `status: "running"`
and `exitCode: null`. After recording the outcome before removal, the test
passed.
