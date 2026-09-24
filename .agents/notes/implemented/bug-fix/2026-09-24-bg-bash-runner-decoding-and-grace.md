# Agent Note: Decode stdio with StringDecoder and cap the post-exit grace

Status: implemented

## Problem

Two independent defects in `plugins/bg-bash/src/runner/run.ts`:

1. **Mojibake on chunk boundaries.** `forward` decoded each pipe chunk with
   `chunk.toString("utf8")`. When a multi-byte character straddles two chunks —
   common for CJK output, box-drawing characters, emoji — each half decoded to
   U+FFFD, corrupting both the in-memory tail buffer and the log file. pi's
   own readers (`session-manager`, the JSONL line reader) use `StringDecoder`
   for exactly this reason.
2. **Unbounded post-exit draining.** `waitForTermination` re-armed a 100ms
   grace timer on *every* chunk after `exit`, so a detached descendant that
   holds the stdio pipe and writes forever (`nohup tail -f x &`, a watcher)
   kept the outcome pending for the descendant's whole life: the job stayed
   `running`, the follow-up never arrived, and `timeoutMs` was the only way
   out — mislabelling a finished command as `timedout`.

## Decision

- Each stream gets its own `StringDecoder("utf8")`; `decoder.end()` is flushed
  on stream `end` so a trailing partial sequence still surfaces.
- `waitForTermination(child, exitGraceDeadlineMs)` arms a non-rearming
  deadline (default `EXIT_STDIO_DEADLINE_MS = 5000`) when `exit` fires. The
  quiet-grace still re-arms per chunk for actively-writing descendants; the
  deadline bounds the total drain. `startCommand` exposes the bound as
  `exitGraceDeadlineMs` so tests do not wait five seconds.

## Alternatives considered

**Resolve on `exit` unconditionally.** That was the original upstream bug this
grace logic exists to prevent: a short-lived shell can exit while a detached
descendant is still writing real output, and dropping it truncates the log.

**Kill the descendant at the deadline.** `finalize` already destroys the
stdio streams, which SIGPIPEs a Unix writer; on Windows there is no portable
way to reach a reparented descendant, and the job contract is about the
*shell's* outcome, not its orphans.

**A longer or configurable deadline.** 5s is generous for a drain that exists
to catch a few trailing chunks; making it configurable per-command is a
`startCommand` option already, so callers that need more can ask.

## Consequences

Non-ASCII output is byte-faithful in both the tail buffer and the log file.
A command whose shell has exited settles within at most ~5s regardless of
what its descendants do, so `bg_tasks list` and the completion follow-up
reflect reality.

The deadline only starts at `exit`; a still-running shell is unaffected.

## Verification

- `plugins/bg-bash/test/run.test.ts` — `decodes a multi-byte character split
  across chunks` writes the three bytes of `中` in two flushes and asserts the
  joined output is the intact character; `a descendant that never stops
  writing cannot outlive the grace deadline` drives `waitForTermination` with
  a fake child whose stdout ticks faster than the quiet-grace; the real-shell
  variant pins the end-to-end path.

Proved: before the change, the split-character test failed with
`Expected: "中" / Received: ""`, and with the deadline line disabled the
fake-child test hung until the 15s test timeout; after it,
`bun test plugins/bg-bash` runs `52 pass, 0 fail`.
