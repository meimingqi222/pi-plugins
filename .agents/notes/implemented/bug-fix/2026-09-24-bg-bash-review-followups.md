# Agent Note: bg-bash review follow-ups — capacity, lifecycle, and inspection fixes

Status: implemented

## Problem

A review of `plugins/bg-bash` after the log-lifecycle rework surfaced a set of
smaller defects, each independently wrong:

1. **The capacity check refused foreground commands.** `atCapacity()` ran
   before the mode mattered, so with 20 background jobs up even `echo hi` was
   rejected with "Too many background jobs".
2. **`session_start` never reset the registry.** When pi reuses the process
   across sessions, `bg_tasks list` showed the previous session's dead jobs
   and the id counter kept climbing.
3. **`bg_tasks log` read only the file.** The write stream buffers, so a
   running job's log lagged; the in-memory `TailBuffer` is fresher and cannot
   contain another session's output.
4. **The poll guard was too narrow and too broad at once.** It matched only
   `sleep <num>` (missing `sleep 30s`, `sleep 30 # comment`, PowerShell's
   `Start-Sleep`/`sleep` alias, and the `powershell` tool entirely) while also
   counting *foreground* jobs as a reason to block — terminating a batch that
   contained a legitimate sleep alongside a running foreground command.
5. **`allocateLogPath` returned a path even when `mkdir` failed**, leaving a
   dangling `Full output:` pointer to a file that could never exist.
6. **`kill()` set `killed = true` unconditionally**, so a kill racing a natural
   exit could relabel a real exit code as killed.
7. **`TailBuffer.trim()` re-measured the whole buffer on every append** —
   quadratic for a chatty job.
8. **`emitUpdate` pushed the full 256KB tail to the UI every 100ms** instead of
   the same capped tail the final result renders.
9. **`bg_tasks kill` reported "Stopping" without confirming**, so the reply
   could claim a stop while the status still read `running`.
10. **Log files had no provenance**: no record of which session, directory, or
    command produced them.

## Decision

- The capacity check moved inside `explicitBackground`; a foreground command
  always runs and may exceed the limit if it auto-backgrounds — preferable to
  blocking forever.
- `JobRegistry.reset()` clears jobs and the id counter; `session_start` calls
  it (shutdown already killed anything running).
- `bg_tasks log` prefers `job.output.text()`, falling back to the file only
  when the buffer is empty or has actually dropped bytes.
- `PURE_WAIT_PATTERN` accepts GNU suffixes (`30s`/`1m`), a trailing comment,
  and `Start-Sleep`; the guard fires for `bash` and `powershell` tool calls
  and only counts `mode === "background"` jobs.
- `allocateLogPath` returns `undefined` when the directory cannot be created.
- `kill()` returns early once the run has settled.
- `TailBuffer` tracks `bufferBytes` incrementally.
- `emitUpdate` sends `truncateOutput(...).text`, matching the final render.
- `bg_tasks kill` polls the job status for up to 2s and reports the terminal
  status (or "still terminating").
- `startCommand` accepts `logHeader`; the tool writes `# job … session … cwd`
  and `# command …` lines at the top of each log file.

## Alternatives considered

**Refuse foreground commands at capacity too.** That trades a soft bound for a
hard hang: a foreground command that cannot detach blocks its tool call
indefinitely, which is the failure this plugin exists to prevent.

**Await the job outcome inside `bg_tasks kill`.** The registry does not retain
the outcome promise; a bounded status poll reaches the same terminal answer
without new plumbing.

**Inherit jobs across `session_start` instead of resetting.** A new session
cannot act on another session's jobs anyway (their ctx is gone), and the id
counter restarting is what makes log names meaningful per session.

## Consequences

Foreground work is never refused for background bookkeeping reasons; sessions
start with a clean job table; `bg_tasks log` shows the freshest output;
polling is caught across both shells without terminating legitimate batches;
and every log file is self-describing.

The kill poll adds up to 2s to `bg_tasks kill` in the worst case (a job that
refuses to die), which is the honest answer to report anyway.

## Verification

- `plugins/bg-bash/test/bash-tool.test.ts` — capacity refuses explicit
  backgrounding but still runs a foreground command.
- `plugins/bg-bash/test/plugin.test.ts` — `session_start` reset, powershell
  poll guard, foreground-job exemption, buffer-preferred log read, and the
  updated kill confirmation message.
- `plugins/bg-bash/test/jobs.test.ts` — `reset()` semantics.
- `plugins/bg-bash/test/poll-guard.test.ts` — suffixes, comments, and
  `Start-Sleep`.
- `plugins/bg-bash/test/logs.test.ts` — `allocateLogPath` undefined on
  failure and the provenance header.

Proved: before the change, the buffer-preference test returned
`STALE-FILE-CONTENT` from the file instead of the live buffer, and the
foreground-at-capacity path threw `Too many background jobs`; after it,
`bun test plugins/bg-bash` runs `61 pass, 0 fail`.
