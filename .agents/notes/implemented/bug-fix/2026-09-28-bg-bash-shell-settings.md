# Agent Note: pi-bg-bash honours pi's shellPath and shellCommandPrefix settings

Status: implemented

## Problem

`pi-bg-bash` advertises itself as a drop-in replacement for the builtin `bash`
tool, but it ignored the two shell settings pi itself applies:

- `shellPath` — the builtin resolves the interpreter through
  `getShellConfig(settings.getShellPath())`; bg-bash called `getShellConfig()`
  with no argument, so a configured shell was silently unused.
- `shellCommandPrefix` — the builtin runs every command as
  `${prefix}\n${command}`; bg-bash executed the raw command, so a project that
  relies on a prefix (an env bootstrap, a `direnv`-style preamble) behaved
  differently under this plugin than under the builtin.

## Decision

`Runtime` gained an injectable `shellSettings(cwd)` seam returning
`{ shellPath?, commandPrefix? }`. The production implementation resolves pi's
`SettingsManager.create(cwd, getAgentDir())` **per call** — construction only
reads settings (persisted state is written by explicit mutation, not by
`create`), so per-call resolution is cheap and a project-level settings file
written mid-session takes effect immediately. Any failure reading settings
falls back to `{}`; a settings problem must not fail the command.

`bash-tool.ts` prepends the prefix exactly as pi does —
`${commandPrefix}\n${params.command}` — and forwards `shellPath` to
`startCommand`. The recorded `job.command` and the log header keep the
command the model wrote: the prefix is environment setup, not the command.

## Alternatives considered

- **Cache the SettingsManager per cwd.** Saves a re-read per call, but the
  settings can change mid-session and the read is on the order of a small file
  parse — staleness was the worse failure.
- **Show the resolved command in the log header.** Rejected: the header is
  provenance for what the agent asked to run; recording pi's injected prefix
  there would misattribute environment setup to the model.
- **Read settings once at extension load.** Same staleness problem, plus it
  fixes `cwd` before any tool call exists.

## Consequences

A project `shellPath` or `shellCommandPrefix` now behaves identically under
bg-bash and the builtin tool. Tests inject the seam instead of constructing a
SettingsManager, so no pi settings file is needed to exercise either setting.

## Verification

- `plugins/bg-bash/test/bash-tool.test.ts` — "prepends the configured
  shellCommandPrefix like the builtin tool" (prefix `export BG_PREFIX_PROBE=ok`
  makes `echo $BG_PREFIX_PROBE` print `ok`, while `details.command` stays the
  user's command) and "passes the configured shellPath through to the runner"
  (a marker shell script proves which executable ran).

Proved: with `plugins/bg-bash/src/pi/bash-tool.ts`,
`plugins/bg-bash/src/pi/runtime.ts` and `plugins/bg-bash/src/pi/index.ts`
stashed,
`bun test plugins/bg-bash/test/bash-tool.test.ts` failed — 4 pass / 2 fail
(prefix test produced no `ok`; the marker shell never ran). After restoring,
9 pass / 0 fail across `bash-tool.test.ts` and `tasks-tool.test.ts`.
