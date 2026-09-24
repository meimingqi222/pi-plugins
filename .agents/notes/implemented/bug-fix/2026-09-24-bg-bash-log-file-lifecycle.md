# Agent Note: Isolate and bound bg-bash log files

Status: implemented

## Problem

Every `bash` call — foreground included — wrote its full output to
`~/.pi/bg-bash/logs/<jobId>.log`, and the files were never cleaned up. Three
defects compounded:

1. **Job ids restart at `bg001` in every process** (`JobRegistry.next = 1`) and
   the log stream opened with `flags: "a"`, so a new session *appended* to a
   previous session's file. Worse, two concurrent pi processes interleaved
   writes into the same `bg001.log`. `Full output:` pointers and
   `bg_tasks log` (a 256KB tail read) could therefore show output from an
   unrelated command in another session or project.
2. **No pruning.** The directory grew with every command ever run; the README
   documented this as a limitation.
3. **Unhandled `WriteStream` `error`.** `openLog` caught only synchronous
   failures; an asynchronous stream error (ENOSPC, deleted directory, handle
   exhaustion) would emit `error` with no listener and take the host process
   down with an uncaught exception.

Reproduction for (1): three separate processes each running `echo MARK-<x>`
with the same log dir produced a single `bg001.log` containing all three
markers, no separator. On a live machine, `bg149.log` was created at 23:54:35
while `bg009.log` was modified at 23:54:36 — only possible if a new process
restarted ids and appended to the existing file.

## Decision

- `allocateLogPath(jobId, sessionId)` names files `<sessionId>-<jobId>.log`,
  sanitizing the session id for filesystem use. The session id comes from
  `ctx.sessionManager.getSessionId()`; when unavailable the bare job id is
  used (old behaviour, still correct within one process).
- The stream opens with `flags: "w"`: a log path is unique to one job in one
  session, so an existing file is stale, not history.
- `sweepLogDir()` runs on `session_start`: files older than
  `PI_BG_BASH_LOG_RETENTION_DAYS` (default 7, `0` disables) are deleted, then
  at most the newest `MAX_LOG_FILES` (200) are kept. Best-effort throughout —
  a locked or vanished file is left for the next sweep.
- `stream.on("error", () => stream.destroy())` consumes asynchronous write
  failures; `forward` skips a destroyed stream.

## Alternatives considered

**A monotonic global counter or timestamped names without session ids.**
Timestamps alone still collide between concurrent processes started in the
same second; the session id is already the identity pi gives us, and it makes
`bg_tasks list` output self-describing.

**Prune on every job creation instead of `session_start`.** A `readdir`+`stat`
per command is wasted work; once per session is enough to bound growth, and
the sweep is cheap at the sizes the count cap produces.

**Cap each file's size.** The in-memory tail is already capped at 256KB; the
file exists precisely to hold what the tail drops, so truncating it would
defeat `Full output:` for verbose commands.

## Consequences

Log files are attributable to exactly one session and bounded in count and
age. `bg_tasks log` and `Full output:` pointers can no longer surface another
session's output. A disk-full event degrades to memory-only output instead of
crashing pi.

Old files from before this change keep their unprefixed names; they age out
through the same retention sweep.

## Verification

- `plugins/bg-bash/test/logs.test.ts` — pins the session-prefixed name, the
  two-sessions-same-job-id isolation, truncation on path reuse, the
  unwritable-path degradation, and all four sweep behaviours (age, count cap,
  `0` disables, non-log files ignored).
- `plugins/bg-bash/test/plugin.test.ts` — existing end-to-end tests exercise
  the new `allocateLogPath(job.id, sessionId)` call path unchanged.

Proved: before the change, `bun test plugins/bg-bash/test/logs.test.ts`
failed at import (`sweepLogDir` not found) and the three-process probe
produced one shared `bg001.log` containing `MARK-AAA`, `MARK-BBB`, and
`MARK-CCC`; after it, `52 pass, 0 fail` and each session writes its own file.
