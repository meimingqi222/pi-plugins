# Agent Note: pi-workflow review fixes — double admission, stale budget, split run id

Status: implemented

## Problem

A read-through of the finished plugin found three real bugs the suite did not
pin:

1. **Agent budget was charged twice per call.** The bridge admitted once
   (`callbacks.admit(1)`) and the orchestrator's `runAgent` admit callback
   admitted again on every attempt, so `maxAgents: 2` allowed a single agent
   call. Only `agents: 0` was tested, which passes under both behaviours.
2. **`budget.spent` never moved inside a script.** The worker refreshes its
   budget global from `reply.spent`, but the `agent-result` reply never carried
   the field — only `budget-result` did. A script reading `budget.spent` after
   work ran saw 0 forever.
3. **The tool's run id was not the run's id.** `execute` minted one `runId` for
   the registry handle and `executeWorkflow` minted another for the journal and
   result. The id the model was told to `stop` or `resumeFromRunId` named a run
   with no journal on disk.

## Decision

- Orchestrator: `admit: (attempt) => budget.admit(attempt === 1 ? 0 : 1)` —
  attempt 1 was already admitted by the bridge, so it only re-checks the token
  axis; retries are genuinely new child invocations and admit one each.
- `HostAgentResult` gains `spent`, filled from `callbacks.budget().spent` after
  each call, so the worker's `budget` global tracks real spend.
- `executeWorkflow` accepts a pre-resolved `source` and `runId`; `execute`
  resolves both once and passes them down, so the handle, the journal
  directory, and the delivered result all name the same run.

## Alternatives considered

**Keep the bridge's admission and make the orchestrator's attempt-1 admission a
no-op by skipping it entirely.** The token axis is what stops a retry after the
budget is spent, so attempt 1 still has to run the check; admitting zero agents
is the smallest change that keeps one agent call equal to one agent admission
while leaving the retry arithmetic intact.

**Have the worker read spend from a separate `budget` request rather than the
agent-result reply.** That adds a round trip per call and a second source of
truth for a number the reply already computes.

**Let `executeWorkflow` mint the run id it writes under.** That is the bug: the
handle, the journal directory, and the delivered result would name different
runs, and `resumeFromRunId` would address a run with no journal on disk.

## Consequences

`maxAgents` is an actual bound: `agents: 2` admits two child invocations, not
one. A schema retry counts as a new invocation and is refused once the agent
budget is exhausted, which is the intended fail-closed direction. Scripts
reading `budget.spent` see real spend instead of a constant 0, so a script can
branch on it. The tool's handle, the on-disk journal, and the delivered result
share one run id, so `resumeFromRunId` and `/workflows stop` address the run the
model was told about. `HostAgentResult` gained a `spent` field, internal to the
package.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — `agents: 2` admits exactly two
  calls; a schema retry under `agents: 1` runs attempt 1 and is refused on the
  retry.
- `plugins/workflow/test/host.test.ts` — `budget.spent` reads 0 before and 6
  after two agent calls.
- `plugins/workflow/test/plugin-wiring.test.ts` — the delivered record's
  `result.runId` equals the handle's `runId`.
- Live smoke test: a real `pi --mode json` session ran a one-line
  `agent('Reply with exactly: pong')` script end to end — child spawned, `pong`
  returned, journal written, result delivered as a `workflow-result` message.

Proved: minting a fresh run id inside `executeWorkflow` instead of threading the
resolved one failed `plugins/workflow/test/plugin-wiring.test.ts`'s "the
handle's runId is the run's own id" with two different `wf_` values, then
passed again after the resolved id was threaded through.

Full workspace: 546 pass, 0 fail; typecheck clean on all six packages.
