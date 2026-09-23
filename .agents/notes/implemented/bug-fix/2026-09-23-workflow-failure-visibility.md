# Agent Note: Make a failed workflow call visible, and give the per-agent timeout a real effect

Status: implemented

## Problem

A real run (`wf_b5ca2570f7054ed5`, launched against `/Users/yuqiang/work/code/agents`)
looked hung. Its session log is the evidence, and it showed twenty minutes of the
model sleeping and re-reading the run directory while nothing appeared.

What the run directory held after twenty minutes was `script.js` and nothing else.
No `journal.jsonl`, no result, no delivered message. The child `pi` processes were
seen at ~0% CPU and then not at all, while a direct probe of the same child
command (`pi --mode json -p --no-session -- "..."`) returned in under 80 seconds.

That combination — no journal, no children, a working probe — is not diagnosable
from the artifacts, and that was the actual defect. Four concrete gaps produced it.

**Failed calls were not journaled.** The only `journal.append` call sat on the
success path. A call that exhausted its schema retries, or whose executor
reported a failure, incremented a counter in memory and rethrew. So a run in
which *every* call failed left a directory indistinguishable from one that never
started, or from one still working. `WorkflowJournalEntry` already declared
`status: "failed"`; nothing wrote it, and `isJournalEntry` rejected it as
malformed.

**`progress.json` was declared and never written.** `WorkflowJournal` exposed a
`progressPath` and a `PROGRESS_FILENAME`, and no code touched either. The model in
the log spent a whole turn looking for it.

**`agentTimeoutMs` did not mean what it said.** The tool described it as a
"Per-agent wall-clock cap", but mapped it onto `runWorkflow.timeoutMs` →
`runScriptHost.timeoutMs`, the whole-script cap. The per-agent timeout lived in
`createPiExecutor`'s options, and `pi/index.ts` built the executor as
`createPiExecutor()` with no options — so the per-agent cap was fixed at the
15-minute default and could not be set at all. The one control a caller would
reach for to bound a hung child did nothing to a child.

**A hung agent left no transcript.** Children are spawned with `--no-session`
(deliberately: a fan-out of hundreds must not fill the session store), so when an
agent hangs there is nothing to read. A timeout reported only
`The agent timed out after Nms`.

The trigger for this particular run is still unknown — a strict 15-field schema
retried three times, or a hanging `bash` inside a `qa` agent (which is allowed
`bash`) — and it cannot be settled, because the evidence was designed away.

## Decision

Make the failure path as observable as the success path, and make the timeout
knobs mean what they say.

- **Journal failures, not just successes.** The failure path appends a
  `status: "failed"` entry carrying the error. `isJournalEntry` now accepts
  `failed` as a real line, so the sequence stays contiguous; `isReusable` still
  rejects it, so resume stops at the failure and re-attempts from there. The
  summary derives `status: "failed"` from zero successes plus failures, and
  reports `failedCalls` and `lastError`.
- **Write `progress.json`.** `WorkflowJournal.writeProgress` writes the snapshot
  atomically. The orchestrator emits into a throttled writer and forces a
  terminal write (`settleProgress`) before returning, so the file always ends with
  the run's real outcome. Live precision stays with `workflow_status`; the file is
  for the case where the process that owned the run is gone.
- **`agentTimeoutMs` bounds one agent.** It now travels on
  `WorkflowAgentRunInput.timeoutMs` and the executor prefers
  `input.timeoutMs ?? options.timeoutMs ?? default`. The whole-run cap got its own
  `runTimeoutMs` parameter rather than sharing the name.
- **Keep the child's event stream.** When the orchestrator has a journal it passes
  `evidencePath = <runDir>/agents/<agentId>.jsonl`, and the executor appends each
  raw stdout line to it through an ordered, best-effort queue. `finish()` flushes
  that queue before resolving, so a reader that has the result also has the
  transcript. A timeout error now names the file.

## Alternatives considered

**Drop `--no-session` and read the child's session transcript.** The simplest way
to get evidence, and it undoes a deliberate decision: a fan-out of hundreds would
fill the session store with transcripts nobody asked for. Tailing the child's own
event stream to a per-agent file gives the same diagnosis without that cost.

**Write `progress.json` on a timer instead of on `emit`.** A timer keeps writing
while a single long agent is silent, which is exactly when a reader learns least,
and it keeps the process awake after the run ends. Writing on progress events plus
a forced terminal write puts the file where the information is.

**Record failures but keep `isJournalEntry` rejecting them.** Then `load` would
treat the first failure as the end of the parseable prefix and drop every later
line, silently truncating a run whose failures are followed by successes.

**Make `agentTimeoutMs` set both caps.** It is one number for two different
questions — how long one child may run, and how long the whole script may run —
and conflating them is what the parameter already got wrong.

## Consequences

A run directory now answers "what happened" without the session: `journal.jsonl`
names each call's outcome, `progress.json` names the phase and the last event, and
`agents/*.jsonl` holds the child's own stream. `/workflows` shows failed counts and
the last error.

Failures becoming journal lines changes the resume prefix: a resumed run stops at
the first failed call and re-runs from there. That is the fail-closed direction —
a resumed run must not inherit a failure it never re-attempted — but it means a
run with an early flake re-executes more than a run with none.

`agentTimeoutMs` now shortens only individual agents, so a caller who used it to
cap the whole script must pass `runTimeoutMs` instead. The default per-agent cap
is unchanged at 15 minutes; the whole-run cap defaults to the host's 30 minutes.

The evidence files are unbounded per agent, like the journals. A run that fans out
widely writes one file per agent under its run directory.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — a failed call is journaled as `failed`; the progress snapshot ends with the terminal status; `agentTimeoutMs` and `evidencePath` reach the executor
- `plugins/workflow/test/progress.test.ts` — the on-disk summary reports failures, `failedCalls`, `lastError`, and reads zero-successes-with-failures as `failed`
- `plugins/workflow/test/pi-executor-spawn.test.ts` — a per-call timeout overrides the executor default; the child's stream lands in the evidence file; a timeout names it
- `plugins/workflow/test/plugin-wiring.test.ts` — the tool maps `agentTimeoutMs` to the per-agent cap and passes an evidence path
- `plugins/workflow/test/core.test.ts` — a `failed` entry is a valid journal line and is still not reusable

`185 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: four red runs, one per fix, each on the assertion it is meant to carry.

- **The failure append's status changed to `completed`.** It failed
  `workflow observability on disk > a failed call is journaled, not only the successes`,
  which received `["completed"]` where it expects `["failed"]`.
- **The terminal progress write removed from `settleProgress`.** It failed
  `workflow observability on disk > progress.json is written and ends with the terminal status`
  with `Received: "running"`, proving the assertion is about the forced terminal
  write and not merely about the file existing.
- **`agentTimeoutMs` mapped back onto `runWorkflow.timeoutMs`** (the original
  bug). It failed
  `timeout and evidence wiring > agentTimeoutMs reaches every agent; runTimeoutMs does not replace it`
  with `Received: undefined` for the executor's `timeoutMs`.
- **The evidence sink made a no-op.** It failed
  `pi executor diagnostics > the child's raw event stream is written to the evidence path`
  with `ENOENT` reading the file, so the test pins that the stream is actually
  persisted rather than that a path was computed.
