# Agent Note: Bound the drain for agent calls a script abandoned

Status: implemented

## Problem

After the worker posted `complete` (or failed), the host awaited
`Promise.allSettled([...inFlight])` with no bound. Any `agent()` the script
started but did not await stayed in `inFlight`, so the run did not settle until
that child finished — up to the executor's 15-minute default.

The cost is not the wall clock alone. The run keeps its slot in the run registry
and keeps a live child session, while the result it will eventually produce says
`completed` — and the script's return value has been final since before the
wait began. The module's own rule 2 already said "an abandoned handler must not
hold the run open"; the code contradicted it, and no test covered the shape.

## Decision

Bound the drain with `abandonedAgentDrainMs` (default 5s, overridable in
`ScriptHostOptions`, which is what makes it testable) and record what was given
up. When the grace expires with calls still in flight, the run still reports
`completed` — its value is final and calling that a failure would be a lie —
but `stopReason` becomes
`completed; N agent call(s) were still running at script exit`, which `/workflows`
and the tool already surface as `Reason: …`.

A non-zero grace, rather than settling immediately, keeps the one real benefit of
waiting: a child that is mid-write finishes its write instead of being cut off by
the run teardown. `inFlight` is only emptied by a settling handler, so the count
read after the race is exactly the set being abandoned — no bookkeeping needed.

## Alternatives considered

- Settle immediately and let the teardown kill the children: fastest, but turns
  every abandoned call into a mid-write kill, and the teardown is the only thing
  making it safe.
- Keep the unbounded wait and document it: the run-slot occupancy is the
  user-visible problem, and documentation does not release the slot.
- Fail the run instead of qualifying it: the script completed and its value is
  usable; a failure status would discard real work.

## Consequences

A run whose script abandons work now settles within the grace and says so, so a
`completed` run no longer hides an unfinished child. The abandoned child's
result is dropped (it was already unreachable — the worker that asked for it is
gone). Consumers that compare `stopReason` to `"completed"` for equality must
account for the qualified form; `stopReason` was already `string` on the journal
record, and the one equality check in the orchestrator is for `"failed"`, which
is untouched. Runs that await their agents keep the plain `"completed"` value,
pinned by a negative-control test.

## Verification

- Test file: `plugins/workflow/test/host.test.ts`
- `plugins/workflow/test/host.test.ts::an un-awaited agent call cannot hold a completed run open`
- `plugins/workflow/test/host.test.ts::a run whose agents all finished still reports plain completion`
  is the negative control: the qualified reason must not appear when the script
  awaited its work.

Proved: with the test written but before the fix, `bun test
plugins/workflow/test/host.test.ts` reported 29 pass / **1 fail** — `(fail)
script host shutdown > an un-awaited agent call cannot hold a completed run open
[5001.63ms]`, the test timing out because the run waited on an agent that never
resolved. After the fix the same command is 30 pass / 0 fail, and the
abandoned-call case settles in well under the drain grace's own 5s assertion.
