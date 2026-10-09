# Agent Note: Refuse to write a job log through a symlink

Status: implemented

## Problem

The reader side of `pi-bg-bash` already refuses a symlinked log path —
`tasks-tool.ts` and `settings.ts` both `lstat` the path and treat a link as
"no readable log". The writer did not: `openLog` called
`createWriteStream(path, { flags: "w" })`, which follows a symlink and
truncates its target.

A job's log path is not a secret. `bg_tasks status` reports `logPath` back to
the model, and the name is predictable
(`<logdir>/<session>-<jobNNN>.log`), so a symlink can be planted at a path the
next run will write to. That turns the log writer into a way to truncate or
overwrite any file the pi process can write — including files the
permissions layer would have prompted for on a direct write, which the log
writer bypasses entirely.

## Decision

Open the log descriptor with `O_NOFOLLOW` and hand it to the stream
(`createWriteStream(path, { fd: openSync(path, WRITE_FLAGS) })`). A symlink at
the path now fails with `ELOOP`, the existing `try`/`catch` returns `undefined`,
and the job simply runs without a file log — the same degradation the reader
already tolerates. `O_NOFOLLOW` is omitted where the constant is absent
(Windows, where creating the link needs privileges), keeping the previous `"w"`
behaviour there.

The descriptor is opened here rather than by the stream because an
`lstat`-then-open check is racy: a link can be planted between the two calls.
One `open` with `O_NOFOLLOW` refuses in the kernel, so there is no window.

## Alternatives considered

- `lstat` and refuse, mirroring the reader literally: simpler, but leaves a
  TOCTOU window between the check and the open, which is exactly the window a
  planted link is aimed at.
- `lstat` and delete the link, then create the file: a planted link is not
  stale output worth clearing, and silently replacing it hides the attempt.
- Leave the writer alone because "the model already has a bash tool": the bash
  tool goes through the permissions layer, and this path does not — that
  asymmetry is the whole finding.

## Consequences

A symlinked log path yields a job with no file log instead of a truncated
target. The job's output is still captured in memory and readable through
`bg_tasks` (which is why the reader had already chosen refusal over failure), so
no diagnostic is lost beyond the on-disk copy. Windows keeps the old behaviour,
so a Windows-specific link attack is not covered by this change.

## Verification

- Test file: `plugins/bg-bash/test/run.test.ts`
- `plugins/bg-bash/test/run.test.ts::refuses to write a log through a symlink`

Proved: with the test written but before the fix, `bun test
plugins/bg-bash/test/run.test.ts` reported 8 pass / **1 fail** — `(fail)
startCommand > refuses to write a log through a symlink [8.63ms]`, because the
target file had been truncated to the command's output. After the fix the same
command is 9 pass / 0 fail and the target still holds its original bytes.
