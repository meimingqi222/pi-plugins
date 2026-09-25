# pi-bg-bash

Cross-platform background bash for pi. A command that outlives a threshold is
detached instead of blocking the turn, and its result comes back as a follow-up
message.

## Why this exists

pi's built-in `bash` tool has an optional `timeout` and **no default**. If the
agent runs a command that deadlocks — a test with a lock ordering bug, a watcher,
a prompt waiting on stdin — the tool call never returns. Nothing observes the
process, so the only way out is a human pressing Escape.

The two obvious answers both fail:

- **A fixed timeout** cannot tell a slow command from a hung one. It turns
  "still running normally" into "killed", so it must be guessed before the
  command runs, and the case that matters — a command nobody expected to hang —
  is exactly the one nobody sets a timeout for.
- **tmux** is observable and interactive, but it is also opt-in: the model must
  decide *before* executing that this command should go to tmux. A deadlock is
  by definition unanticipated, so pre-emptive routing misses it.

The mechanism that actually covers the surprise is **unconditional
auto-backgrounding**: every command is raced against a threshold. Under it the
call behaves exactly like the built-in tool; over it the process keeps running,
the tool call returns, and the model gets to look at a live job and decide
whether to wait, read more output, or stop it. The decision moves from *before*
execution to *during* it.

## Behaviour

- **`bash` is replaced, not shadowed.** Same name, same parameters plus
  `background`, same output truncation, same "throw on non-zero exit". Short
  commands are indistinguishable from the built-in tool.
- **Auto-background.** When a command is still running after the threshold
  (default `30s`), it is registered as `bgNNN`, the tool call returns
  immediately, and a `bg_bash_result` follow-up with the final output and exit
  code is injected when the process ends.
- **`background: true`.** Detach immediately, for commands known to be long
  (builds, dev servers, watchers).
- **`bg_tasks`.** `list`, `status <id>`, `log <id>`, `kill <id>`. This is the
  part that makes a hung job recoverable: read what it has printed, then stop it.
- **No wait-polling.** A bare `sleep` while a job is running is blocked and the
  turn ends, so the model is woken by the job's completion instead of spinning.
  A command with a purpose (`sleep 5 && npm test`) is untouched.
- **Full output is on disk.** Every chunk is appended to
  `~/.pi/bg-bash/logs/<id>.log`; the model-facing result keeps the last 2000
  lines / 50KB and points at the log.

## Cross-platform

The runner never hard-codes `bash -lc`. It resolves the shell through pi's own
`getShellConfig()` — Git Bash on Windows, `/bin/bash` then `sh` on Unix, and
stdin transport for legacy WSL `bash.exe` — and terminates process trees the way
each platform requires: a detached process group and a negative-pid `SIGKILL` on
Unix, `taskkill /F /T` from the trusted System32 copy on Windows.

What this means in practice:

| Platform | Shell used | Termination |
|---|---|---|
| macOS / Linux | `/bin/bash`, else `bash`, else `sh` | `SIGKILL` to the process group |
| Windows | Git Bash (`bash.exe`), else WSL/Cygwin/MSYS2 `bash.exe` | `taskkill /F /T /PID` |

On Windows the kill is forceful; there is no portable graceful `SIGTERM`, so a
stopped job does not get a chance to clean up.

## Configuration

Threshold precedence, highest first:

| Source | Key |
|---|---|
| Environment | `PI_BG_BASH_THRESHOLD` (seconds) |
| Project | `autoBackgroundAfterSeconds` in `<cwd>/.pi/bg-bash.json` |
| User | `autoBackgroundAfterSeconds` in `~/.pi/bg-bash.json` |
| Default | `30` |

`0` disables automatic backgrounding; commands then block like the built-in
tool, while `background: true` still works. `PI_BG_BASH_LOG_DIR` overrides the
log directory.

Log files are named `<sessionId>-<jobId>.log`, so a new session never appends
to a previous session's file and concurrent pi processes cannot interleave.
On `session_start` the directory is swept: files older than
`PI_BG_BASH_LOG_RETENTION_DAYS` (default `7`, `0` disables) are deleted, then
at most the newest 200 files are kept.

```json
// <cwd>/.pi/bg-bash.json
{ "autoBackgroundAfterSeconds": 60 }
```

## Limits

- **Only the `bash` tool is wrapped.** On Windows pi also exposes `powershell`;
  a long PowerShell command is not auto-backgrounded and keeps the built-in
  blocking behaviour.
- **Explicit `background: true` is capped at 20 running jobs.** At the cap a
  new background request is refused with an actionable error. Foreground
  commands still run at capacity; one that outlives the threshold may exceed
  the limit rather than block forever.
- **No stdin.** Like the built-in tool, commands get no interactive input. Use
  tmux for something that genuinely needs a TTY.
- **No wake-up for explicit `background: true` if the session ends first.** Jobs
  are killed on `session_shutdown` and on every leave of the launching
  conversation (`session_before_switch`, `session_before_tree`,
  `session_before_fork`). A completion that arrives after that leave is
  dropped instead of injected into the next branch; the log file remains for
  diagnosis.
- **Log retention is coarse.** The sweep runs on `session_start`, so a
  long-lived process only prunes when a session begins; between sweeps the
  directory grows with every command.
- **Logs hold raw output.** The files under `~/.pi/bg-bash/logs/` are the
  command's bytes verbatim — secret-redaction extensions that rewrite tool
  results do not rewrite these files.

## Layout

- `core/` — pure bookkeeping: threshold precedence, the job registry, the output
  tail buffer, and the outcome→status rule. No process, no filesystem, no `pi`.
- `runner/` — shell resolution, spawn, process-tree termination, and the
  exit/stdout draining logic.
- `pi/` — tool registration, config file access, formatting, and the follow-up
  queue.

## Development

```bash
bun test
bun run typecheck
```

The plugin suite spawns real shells; the auto-background tests use a short
threshold and tear the session down afterwards so no process outlives them.
