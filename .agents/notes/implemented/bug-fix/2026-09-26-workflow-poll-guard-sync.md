# Agent Note: workflow poll guard drifted from the bg-bash copy

Status: implemented
Partly-superseded-by: 2026-09-26-bg-bash-late-completion-routing.md

## Problem

`pi-bg-bash` and `pi-workflow` each carry a private copy of the same
wait-poll rule (`poll-guard.ts`), with a comment in both files requiring the
two to be changed together. The bg-bash review-fix commit widened its copy —
GNU suffixes (`sleep 30s`, `sleep 1m`), a trailing `#` comment, and the
`powershell` tool / `Start-Sleep` alias — but the workflow copy was not
updated, so `sleep 30s` or `Start-Sleep 30` polled freely while a workflow
ran while the same command was blocked beside a background bash job.

## Decision

Copied the widened `PURE_WAIT_PATTERN` verbatim into
`plugins/workflow/src/pi/poll-guard.ts`, mirrored the sync-warning comment
(so the rule now points in both directions), and extended the tool-call
guard to the `powershell` tool the same way bg-bash does.

## Alternatives considered

- Extract the rule into `pi-run-core` so there is one copy. Rejected for the
  same reason the copy exists — the plugins install independently and must
  not acquire a shared-code dependency just for one regex.
- Keep the narrow workflow pattern. Rejected: the divergence was an
  oversight against the documented sync rule, and a poll is a poll
  regardless of which background primitive is running.

## Consequences

A bare `sleep 30s`, `sleep 30 # …`, or `Start-Sleep 30` is now blocked with
the same poll reason during an active workflow run. The copies can still
drift; the comments are the only enforcement.

## Superseded

The shared syntax still holds. Bg-bash now blocks a bare sleep without
terminating the turn, because default successful jobs no longer wake the
agent; workflow still terminates because it does wake. The comments now ask
only for parser syntax to stay aligned, not for matching delivery policy.

## Verification

`plugins/workflow/test/poll-guard.test.ts` pins the widened shapes
(`sleep 30s`, `sleep 1m`, trailing comment, `Start-Sleep`).

Proved: with `plugins/workflow/src/pi/poll-guard.ts` stashed to the old
pattern, `bun test plugins/workflow/test/poll-guard.test.ts` fails the
"recognises a bare sleep" case on the new assertions; restoring the widened
pattern makes all 5 tests pass.
