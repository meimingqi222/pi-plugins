# Agent Note: Run every delegation in the background

Status: implemented

## Problem

A default-background tool still exposed `background: false`. Models selected
that blocking path, whose native Paseo child page had no live transcript until
settlement. The user requested one execution mode rather than separate host
support for the blocking option.

## Decision

Remove `background` from both public schemas and remove the extension's entire
foreground launch branch. Every successful launch returns a task ID before
the child completes, uses the RPC child lifecycle, and delivers an unread
answer at a safe parent boundary. Dependent work uses `subagent_tasks.wait`.

Argument normalization discards a legacy `background` field. A stale request
with false therefore still starts background work; it cannot resurrect the
removed branch. Keep the existing concurrency cap, cancellation, reply,
evidence logging, automatic delivery, and goal usage accounting.

## Alternatives considered

- Keep false as an advanced option: the model can still select the path with
  different output timing, reproducing the reported empty child page.
- Fix the foreground Paseo adapter: no longer needed for this plugin after
  selecting background-only execution.
- Block until completion when no mode is supplied: defeats live launch-time
  transcripts and independent parent work.

## Consequences

Launch results contain handles, not final answers. `wait`, `show` and `log`
return settled answers and consume only that answer's pending notification.
Reload Pi to refresh the tool schema and implementation. Existing foreground
host records remain readable; no new tool launch creates one. The internal
lane registry still understands historical foreground records, but the tool
has no foreground execution entry point.

## Verification

- `plugins/subagent/test/plugin.test.ts::the model-facing contract only exposes background execution`
- `plugins/subagent/test/plugin.test.ts::%s legacy execution argument still returns a background handle`
- `plugins/subagent/test/plugin.test.ts::every launched task can be cancelled`
- `plugins/subagent/test/plugin.test.ts::a background launch writes an evidence file`
- `plugins/subagent/test/paseo.test.ts::%s RPC launch reports readable progress before the child finishes`
- `plugins/subagent/test/paseo.test.ts::background %s exposes its transcript under the task identity`
- `plugins/goal/test/lifecycle.test.ts::a real subagent tool reports child usage through the goal service`

Proved: before removing the schema property, the new contract test expected no
`background` field and received true. Output:
`regression-evidence/subagent-background-only-red.txt`. The fixed contract and
legacy argument tests pass; background RPC tests read output before settlement.
