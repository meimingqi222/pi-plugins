# Agent Note: Auto-background long bash commands instead of timing out

Status: implemented
Partly-superseded-by: 2026-09-26-bg-bash-late-completion-routing.md

## Problem

pi's built-in `bash` tool takes an optional `timeout` and has **no default**.
That is fine for scripts and bad for agents: when the model runs a command that
deadlocks — a test with a lock-ordering bug, a watch process, something reading
stdin — the tool call simply never returns. Nothing in the session can observe
the process, so recovery is a human pressing Escape.

A fixed timeout does not solve this, because it cannot distinguish *slow* from
*hung*. It forces a guess before the command runs, and the guess is wrong in
both directions: a legitimate ten-minute build gets killed, while the surprise
deadlock is exactly the command nobody thought to attach a timeout to. The
failure mode we care about is unanticipated, so any opt-in mechanism — a
timeout parameter, routing through tmux, a separate `bg_run` tool the model must
choose — is unavailable precisely when it is needed.

## Decision

Replace the `bash` tool with one that **races every command against a
threshold** and, on crossing it, detaches instead of killing.

- `startCommand` spawns the shell and returns a handle synchronously.
- The tool awaits `Promise.race([result, threshold])`. Under the threshold
  (default 30s) the call is byte-for-byte the built-in behaviour: output
  truncation, throw on non-zero exit.
- Over it, the job is registered, the call returns a notice, and the process
  keeps running. On exit, a `bg_bash_result` follow-up carries the final output
  and exit code.
- `bg_tasks` (`list`/`status`/`log`/`kill`) is the recovery surface: the model
  reads what a suspicious job has printed and stops it if it looks stuck.

The decision moves from *before* execution to *during* it, which is the only
placement that covers a command the model did not expect to hang.

Cross-platform support is the second half of the decision. The upstream
community plugin (`pi-background-bash`) hard-codes `spawn("bash", ["-lc", …])`,
a POSIX process group, and negative-pid `SIGKILL`, so it is Unix-only. Here the
shell is resolved through pi's own `getShellConfig()` — Git Bash on Windows,
`/bin/bash`/`sh` on Unix, stdin transport for legacy WSL `bash.exe` — and tree
termination branches to `taskkill /F /T` on Windows. `core/` stays free of
process and filesystem imports so the registry, threshold precedence, and output
buffer are testable without spawning.

Configuration is env > project `.pi/bg-bash.json` > user `~/.pi/bg-bash.json` >
30s, with `0` disabling auto-backgrounding.

## Alternatives considered

**Add a default timeout to the built-in tool.** The smallest change, and the
worst one: it converts "hangs forever" into "kills slow work", with no way to
tell them apart. Rejected for the reason above.

**Route every command through tmux.** Observable, interactive, and what pi's own
philosophy suggests. But it is opt-in per command, so it misses the unanticipated
deadlock, and it makes the fast path pay for the slow case: every short command
would carry a session creation and a `capture-pane` for its output.

**Adopt `pi-background-tasks`.** Mature and actively maintained, but it exposes
backgrounding as a *separate* tool (`bg_run`) the model must choose — the same
opt-in gap — and it bundles delegated agents, multi-model fusion, and a global
Anthropic attribution rewrite. For "don't hang on a surprise deadlock" that is
both too much surface and the wrong entry point.

**Follow `pi-background-bash` and override `bash`.** This is the right shape and
informed the design, including the `background` flag, the `pbb`-style
management CLI (which becomes `bg_tasks` here), and deferring completions that
arrive mid-request. It was not adopted because of the platform gaps above and
because it re-implements output accumulation and session-env handling instead of
reusing pi's shell resolution and renderers.

**Send the completion immediately instead of queueing on `agent_end`.** A
`triggerTurn` follow-up that lands while a provider request is in flight races
with that request. The queue-and-flush-on-`agent_end` shape is taken from
`pi-background-bash`, which hit the failure in practice.

## Consequences

- `bash` is a different tool now. Anything that inspected the built-in tool's
  `details` still works: the details extend `BashToolDetails`
  (`truncation`/`fullOutputPath`), and the renderers are borrowed from
  `createBashToolDefinition`.
- A failed `kill()` on Windows is forceful; killed jobs get no cleanup window.
- Finished jobs are retained for inspection (last 20) and given up after that;
  the full log stays on disk and is never pruned.
- Background jobs are capped at 20. At the cap a new command is refused with an
  actionable error rather than left running unmanaged.
- Jobs are killed on `session_shutdown`; explicit backgrounds do not survive the
  session.
- Only the `bash` tool is wrapped. Windows `powershell` calls keep the built-in
  blocking behaviour.

## Superseded

The threshold race, cross-platform process handling, and background tool
override still hold. The original unconditional full-output follow-up and
four-action `bg_tasks` surface are replaced by the successor note's
notification policy, persisted terminal records, and bounded result/wait
queries. Log pruning is governed by the later log-lifecycle note. The
historical verification below records the original implementation.

## Verification

- `plugins/bg-bash/test/config.test.ts` — threshold precedence, zero-disables, unusable values
- `plugins/bg-bash/test/output.test.ts` — tail trimming on line and code-point boundaries
- `plugins/bg-bash/test/jobs.test.ts` — status mapping, ids, capacity, retention, kill handles
- `plugins/bg-bash/test/run.test.ts` — real spawn, exit codes, timeout kill, explicit kill, `detach`
- `plugins/bg-bash/test/plugin.test.ts` — end-to-end auto-background, explicit background, `bg_tasks` list/status/log/kill
- `plugins/bg-bash/test/loader.test.ts` — pi's `DefaultResourceLoader` loads the entry and registers `bash` and `bg_tasks`

`33 pass, 0 fail` for the plugin; `bun run typecheck` clean for all seven
packages.

Two red runs, each on the claim it is meant to carry:

- **Auto-backgrounding removed** — `raceCommand` made to await the result and
  ignore the threshold. It failed exactly
  `bash tool > moves a long command to the background and records success without waking`,
  which received the finished output `auto-done` instead of the background
  notice.
- **`detach()` neutered** — the abort listener left attached after a job
  backgrounds. It failed exactly
  `startCommand > detach stops a later abort from killing the command`, which
  saw `outcome.aborted === true` for a command that was supposed to survive the
  abort.
