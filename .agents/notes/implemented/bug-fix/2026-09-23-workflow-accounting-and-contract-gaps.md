# Agent Note: Close the remaining accounting and contract gaps in pi-workflow

Status: implemented

## Problem

A review of the whole plugin after the structured-reply fix surfaced four
defects that share a shape: a path that was correct on the happy case but wrong
on a real one.

1. **A failed or aborted agent still dropped its usage.** `runAgent` threw a
   plain `Error` on `status: "failed" | "aborted"`, so a timed-out agent — often
   the most expensive call, because it ran to the cap — reported zero tokens.
   The `RunAgentError` fix covered the schema path only; this branch was the same
   defect on a different line.
2. **The on-disk summary ignored failed-call spend.** `readRunSummary` skipped a
   `failed` entry before summing its usage, so `/workflows` reported a run that
   cost money as costing nothing — the same undercount the journal fix removed
   from the live path, one layer down.
3. **The executor parsed unconditionally.** A schema-less call whose reply
   happened to be JSON-shaped arrived as a parsed object instead of the text the
   contract promises, because `value` was set whether or not a schema was
   declared.
4. **A script that threw reported `aborted`.** `finish` mapped every
   non-completed run to `aborted`, which conflates "the script crashed" with
   "the run was stopped". The registry then mapped anything non-aborted to
   `completed`, so a `failed` result would have been mislabeled anyway.

Two smaller ones: three copies of the usage-merge logic drifted apart, and
`worker-entry.ts` carried a dead `agentTracked` helper.

## Decision

- **Carry usage on every failure path.** `runAgent` throws `RunAgentError` with
  the accumulated usage for a failed/aborted result too, not only for a schema
  mismatch.
- **Sum usage before the status branch.** `readRunSummary` adds `input + output`
  for every entry, then counts failures separately, so spend is honest whether
  or not the call succeeded.
- **Parse only when a schema was declared.** The executor gates
  `readStructuredReply` on `input.options.schema`, so a schema-less call always
  receives text.
- **Map the status honestly.** `finish` returns `failed` for a script error and
  `aborted` only for an external stop or timeout; the registry records the
  result's status directly instead of collapsing it.
- **One merge.** `agent-runner` and the orchestrator both use
  `mergeWorkflowUsage` from `core/types.ts`; the two local copies are gone.
  `agentTracked` is removed.

## Alternatives considered

**Report a script failure as `aborted` and keep the registry's two-way map.** It
preserves the status quo but keeps the mislabel: a crashed script is not a
cancelled run, and the distinction is what a caller uses to decide whether to
retry or to investigate.

**Parse unconditionally and let the script cope.** It would make a schema-less
call's return type depend on the reply's shape, which is exactly the kind of
surprise the `value`/`text` split exists to prevent.

**Leave the three merges.** They are identical today, but three copies of an
accounting rule is how a fix lands in one place and not the others — which is
what happened here.

## Consequences

A run's reported spend is now honest on every path: success, schema failure,
timeout, abort, and the on-disk summary. A schema-less call's return type is
stable. A crashed script reads as `failed`, a stopped run as `aborted`, and the
registry no longer collapses the two.

The `aborted` → `failed` change is a visible status change for script errors;
the five tests that asserted the old label were updated to the correct one, and
a new test pins the abort-vs-fail distinction so neither can regress into the
other.

## Verification

- `plugins/workflow/test/agent-runner.test.ts` — a failed/aborted agent reports its spent tokens
- `plugins/workflow/test/progress.test.ts` — a failed call's tokens count toward the run's spend
- `plugins/workflow/test/end-to-end.test.ts` — a JSON-shaped reply arrives as text when no schema was declared
- `plugins/workflow/test/orchestrator.test.ts` — an externally stopped run is `aborted`, a thrown script is `failed`

`207 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: three red runs, each reverting one fix.

- **`RunAgentError` given `emptyUsage()` on the failed path.** It failed
  `runAgent failure accounting > a failed or aborted agent still reports the
  tokens it spent` with `Expected: 1, Received: 0`.
- **`readRunSummary` skipping failed usage.** It failed
  `failed-call spend > a failed call's tokens count toward the run's spend` with
  `Expected: 42, Received: 0`.
- **The schema gate removed** (parsing unconditionally). It failed
  `no-schema replies > a JSON-shaped reply still arrives as text when no schema
  was declared` with `Expected: "{\"a\":1}", Received: "NOT-STRING"`.
