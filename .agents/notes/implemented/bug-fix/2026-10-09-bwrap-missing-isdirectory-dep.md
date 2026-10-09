# Agent Note: A missing isDirectory dep aborted the Linux sandbox wrap

Status: implemented

## Problem

`sandboxDeps()` never supplied `isDirectory` — it is optional in `SandboxDeps` and
only the Linux branch consults it. `buildBwrapArgs` therefore fell back to its own
default argument, `(p) => fs.statSync(p).isDirectory()`, and reached the real
filesystem through a seam the caller believed was fully injected. A `denyRead`
path that `exists` reports but `statSync` cannot stat — a CI runner's
`/home/runner/.ssh`, or a TOCTOU race in production — threw ENOENT out of
`wrapSandboxed`.

The handler's fail-closed catch swallowed that throw and turned it into an
"internal error" prompt. The first integration case reached the wrap from the
`action === "allow"` branch, so the single ENOENT prompt replaced the silent
allow; the second reached it *after* the user approved, so the same call prompted
twice. Where the user approves, the command runs with no sandbox rewrite at all:
one unstatable credential path disabled the sandbox for that call.

The darwin branch returns before `buildBwrapArgs`, so this was invisible on the
author's machine. CI is Linux and has bwrap, and `/home/runner/.ssh` does not
exist there, so the pushed suite was the first place the Linux wrap path ran.

## Decision

Keep `isDirectory` optional and make it total. One `isDirectoryOrFalse` helper
guards `statSync` and serves both as `defaultDeps()`'s `isDirectory` and as
`buildBwrapArgs`'s default argument, so no caller — production or a partial test
stub — can reach the real filesystem through the seam. An unstatable denyRead
path is masked as a file.

## Alternatives considered

Making `isDirectory` required in `SandboxDeps` forces every stub to restate it,
but darwin never needs it, so that adds noise to unrelated tests without removing
the default argument. Skipping the mask (`continue`) keeps the wrap working but
leaves the credential path readable inside the sandbox — worse than a loud bwrap
failure. `--tmpfs` hides no more than the file bind and fails the same way when
the path turns out to be a file, so the existing file-mask branch was kept.

## Consequences

An unstatable credential path is masked with `--ro-bind /dev/null`: hidden, and
bwrap fails loudly if it is really a directory rather than running the command
unsandboxed. `isDirectory` stays optional, so stubs that omit it now silently get
the guarded implementation instead of the filesystem. The Linux branch is still
exercised only by CI and by the `envLinux()` unit cases.

## Verification

- Test file: `plugins/permissions/test/sandbox.test.ts`

- `plugins/permissions/test/sandbox.test.ts::a deps object without isDirectory still wraps on linux`

Proved: Before the fix the new case failed on macOS with `error: ENOENT: no such
file or directory, stat '/home/me/.ssh'`, which is the CI failure reproduced
locally. Afterwards the case passes and the wrapped string contains
`'--ro-bind' '/dev/null' '/home/me/.ssh'`.
