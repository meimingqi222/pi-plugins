# Agent Note: Fold the child event log into a transcript, and let the user opt into settle notifications

Status: implemented
Partly-superseded-by: 2026-10-09-task-main-message-view.md

## Problem

Two gaps remained after the fleet surfaces shipped
(`2026-09-27-subagent-fleet-surfaces.md`):

1. The detail view's deepest drill was `l`, a raw JSONL tail. A user asking
   "what did the child do" got event envelopes, not a transcript — and the
   suggested fix (persist child sessions so `pi -r` can reopen them) carried
   real costs the analysis had not yet priced.
2. The only settle announcement was the model-facing `subagent_result`
   message. A user who wanted to *see* a child finish had no switch; the
   panel's `n`-adjacent need was identified during the subscribe-levels
   review (Step-Code's `final|progress|none`) as the one slice with user
   value: progress pushes to the model mid-turn were rejected as noise the
   parent can already pull via `subagent_tasks`.

## Decision

**`src/transcript.ts` — `foldSubagentLog` + `renderTranscript`.** The
evidence log already records every raw JSON-mode event line, so the fold is
pure presentation over the bounded tail `readSubagentLog` returns:

- `message_update` text/thinking deltas accumulate into in-flight blocks;
  `message_end` replaces them with the authoritative message (text parts as
  `assistant` blocks, thinking as `thinking`, `toolCall` parts as `tool`
  rows).
- `tool_execution_start` earns a row even without its message part (the
  child ran the tool whether or not the log kept the arguments), and
  `tool_execution_end` pairs by `toolCallId`, attaching a bounded result
  preview and the error flag.
- Non-JSON lines are skipped; `evidence_truncated` becomes a `note`. The
  panel flags `earlierDataOmitted` so a folded tail never pretends to be the
  whole run.

**`src/panel.ts`** gains a `transcript` view: `t` from list or detail opens
it, `L` inside it drops to the raw log, `Esc` backs out one level at a time
(detail is the hub). The fold re-runs on every render so a running child's
transcript grows live. `n` toggles the user's settle notification from any
view; the footer shows `notify on|off`.

**`src/index.ts`** — `readTranscriptLines` feeds the fold a wider tail
(`SUBAGENT_LOG_MAX_LINES`) than the raw viewer's 40 rows; `notifyDone`
defaults from `PI_SUBAGENT_NOTIFY_DONE`, toggles via `n` or
`/subagents notify [on|off]`, and fires once per settle for `completed` and
`failed` children only — `aborted` is already the user's own act.

## Alternatives considered

- **Persist child sessions and drop `--no-session`** — the full price, now
  evaluated and rejected: (a) every `sa-*` child lands in the same
  cwd-keyed session directory as the user's real sessions and floods
  `/resume`; (b) `PI_SUBAGENT_DISABLE` is an env var and does not travel with
  a session file, so resuming a persisted child yields an unmarked root
  session that can spawn its own children — the one-level fan-out contract is
  bypassed by construction; (c) every child pays session autosave on a
  fan-out that can reach hundreds. The transcript question never needed it;
  the remaining value (follow-up turns, crash resume) has a cheaper shape —
  `keepAlive` (hold the JSON child process open for a follow-up window), the
  Step-Code answer — if it becomes a real need.
- **Model-side `progress`/`none` subscribe levels** — rejected: a mid-turn
  progress steer interrupts reasoning the parent can already pull
  (`subagent_tasks events`); `none` is a pane-transport's territory, not a
  pipe child's — its result is why the transport exists.
- **Replace the raw log view with the transcript** — kept `l`: the raw tail
  is what a debugging user wants when the fold itself is the suspect.
- **Replace detail's `enter` with the transcript** — kept the metadata
  detail as the hub: the transcript is heavier and the detail answers
  "status, usage, result" faster.

## Consequences

The panel's `enter`→`t`→`L` drill answers "what did it do" at three depths
(metadata / folded transcript / raw events) without touching the spawn
contract. Children still run `--no-session`: nothing in `/resume`, nothing
resumable into an unguarded root session. A user who wants settle toasts can
have them; everyone else's default is unchanged. The settle notification is
user-facing only — the model's `subagent_result` message is untouched.

## Verification

- `plugins/subagent/test/transcript.test.ts` — the fold (finished message +
  tool pairing, streaming deltas as live blocks, a `tool_execution_start`
  with no message part, non-JSON lines and `evidence_truncated` as notes,
  per-block text bounds) and `renderTranscript` (omission marker, empty-fold
  text).
- `plugins/subagent/test/panel.test.ts` — `t` opens the folded transcript,
  `L` drills to the raw log, `Esc` returns to detail; `n` toggles from both
  list and detail views.
- `plugins/subagent/test/plugin.test.ts` — unchanged; `/subagents notify`
  shares the command's dispatch.

Proved: disabling the `message_end` fold fails the transcript-fold tests
and the panel's `t`-view test. Reverted; 79 tests pass, `bun run typecheck`
clean.

## Superseded

The fold and notification policies remain authoritative. The raw-preview
reader and detail-first navigation are superseded by
`2026-10-09-task-main-message-view.md`: whole JSON records feed the fold,
and main views open child messages directly with details as an optional drill.
