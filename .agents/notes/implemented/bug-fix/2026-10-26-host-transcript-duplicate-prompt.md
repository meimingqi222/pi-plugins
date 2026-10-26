# Agent Note: Do not seed a live transcript's prompt twice

Status: implemented

## Problem

A host child page (Paseo's provider-subagent panel) follows the append-only
`-host-*.jsonl` transcript that `HostTranscript` writes. For a background lane
that file must contain the prompt before the child has spoken, so `startLive`
seeds it with `lane.task` when nothing has been observed yet.

The child then sends the same prompt itself — pi's subagent framing prefixes it
as `Task: <task>` — and `observe()` appended it as a second user message. The
host rendered both, so the page opened with the task twice: once bare, once
prefixed. Observed on Paseo 0.13.0 with `pi-subagent` background lanes;
`~/.pi/agent/subagent-logs/<session>-<lane>-host-*.jsonl` held both copies as
its first two rows.

## Decision

Remember the seeded text and drop the child's first message when it is that
same prompt.

- `startLive` records `liveSeed = boundText(task)` only when it actually seeded.
- `observe()` clears the seed on the first accepted message. If the first
  message is a `user` message whose body equals the seed, it is skipped: the
  append-only file already carries that prompt.
- The body comparison strips the leading `Task:` framing, because the prefix is
  the spawner's convention rather than part of the task. A child started with a
  different framing still compares equal.
- A first user message that is *not* the seed is kept — it is the child's own
  turn, and the seed is then only a stale placeholder. A later `reply` turn is
  unaffected because the seed is consumed by the first observed message.

The seed itself is unchanged, so the page still has a prompt at launch, before
the child emits anything.

## Alternatives considered

**Stop seeding.** The page would be blank until the child's first event, which
is exactly the window the seed exists to cover; foreground child pages depend
on the same snapshot seeding.

**Seed the framed text (`Task: …`).** The duplicate remains — two identical
messages instead of one framed and one bare.

**Rewrite the live file after the child's prompt arrives.** The contract with
the host is append-only; a follower may already have read the seed, and
rewriting would be invisible to it.

**Deduplicate every later message with the same text.** A user who replies with
the same words would lose that turn.

## Consequences

A host child page shows the prompt once. The surviving copy is the bare task
text rather than the `Task:` framed text, which is the better display and the
text the parent already knows. Non-host consumers are unaffected: the raw log
still carries the child's framed prompt, and the companion output screen reads
that log rather than this transcript.

## Verification

- `plugins/subagent/test/host-transcript.test.ts` — `a live transcript does not repeat the task when the child echoes its prompt`
  and `a live transcript keeps a first user message that is not the seeded task`.

Proved: gating the dedupe branch out (`if (false && …)`) made the first test
report two user prompts where one is expected (`Expected length: 1, Received
length: 2`). Restored.
