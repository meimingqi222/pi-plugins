# Agent Note: Let a read-only agent survive a lost connection

Status: implemented

## Problem

The failure that degraded the user's analysis run was not the workflow's fault
and not the model's: the child process died with

```
Upstream stream ended before terminal chunk
```

`pi-ai` classifies provider errors for its own retry loop, and that wording is
not in its retryable pattern — the pattern has `ended without` and
`stream ended before message_stop`, not this one. So pi did not retry it once,
the child session failed, `runAgent` saw `status: "failed"`, and it threw. One
provider hiccup cost the run its baseline analysis, and (because the budget was
spent by then) its verification step.

The runner's retry budget covered only schema mismatches, so a script had no way
to express "this call produced nothing, try it again" at all. Three of the four
failing runs in the user's history failed on this class: `Upstream stream ended
before terminal chunk`, `Connection error.`, and `429: no available route`.

## Decision

**One re-run, only where re-running cannot duplicate an effect.** A
transport-class failure now consumes a retry instead of failing the call
immediately, bounded by `PI_WORKFLOW_TRANSPORT_RETRIES` (default 1, `0`
disables).

Three parts of that are deliberate:

- **The prompt is re-sent unchanged.** A schema-repair block answers a wrong
  shape; after a transport loss the model never answered, so appending "your
  previous reply did not satisfy the schema" would ask it to fix a reply it never
  made. The attempt loop now tracks *why* the previous attempt failed.
- **Only a provably read-only role qualifies** (`planner`, `reviewer`,
  `researcher`; `isReadOnlyRole`). A child that may have written before it died
  cannot be re-run blind — a duplicated edit or a second `git commit` is worse
  than a missing answer. `qa` does not qualify: it cannot edit, but it can run a
  shell, and a shell can write anything. An unprofiled child is unrestricted, so
  it does not qualify either. The gate is not overridable by the caller.
- **Failures that repeating would reproduce are excluded**: the run's own
  `agentTimeoutMs` (a re-run hits the same cap with the same bill), quota and
  routing errors (`429`, no available route), saturation
  (`concurrency reached, current: 6, limit: 5`), and aborts — an abort is the
  user's decision, not a lost connection.

A transport retry goes through the same `admit` callback as any other attempt, so
it counts against the agent budget and appears in the run's accounting.

## Consequences

A read-only agent that dies of a transport failure is re-asked once; the cost is
one more child invocation, and both attempts are billed in the run's token total.
Write-capable and unprofiled agents are unchanged. The classification is a
regex over provider wording, which is a heuristic: a new provider phrasing will
not match, and the retry will not happen. That direction is the safe one — the
patterns exist so a *timeout* or a *quota* error is never mistaken for a lost
connection and re-billed.

## Alternatives considered

**Retry every failure class.** Simplest, and it re-runs a child that just spent
ten minutes hitting `agentTimeoutMs`, and re-runs a `developer` agent that may
have committed before it died.

**Enable it for writing roles too, since file writes are idempotent.** Not all
of them are, and nothing in the plugin knows which are. A `bash` call is enough
to make the point.

**Fix it upstream instead** — add `upstream stream ended` to `pi-ai`'s
`RETRYABLE_PROVIDER_ERROR_PATTERN`. That is the real root cause and it should
happen, but a plugin cannot depend on an unreleased upstream fix, and a workflow
retry is not the same thing anyway: pi re-requests the stream, while this
re-runs the whole child with a fresh context.

**Retry on the schema budget (`retries`).** Merges two budgets that buy
different things — a correct shape versus a call that produced nothing — and
would silently turn `retries: 3` into three full child spawns on a flaky
provider.

## Verification

- `plugins/workflow/test/agent-runner.test.ts` — "a read-only child that died of
  a lost connection is re-run once" (second attempt re-sends the identical
  prompt, no repair block, both attempts billed); "a child that can write is
  never re-run blind"; "an unprofiled child is unrestricted, so it is not re-run
  either"; "repeating the failure would only reproduce it, so those are not
  retried" (the run's own timeout, a 429 with no route, and `concurrency
  reached`); "an abort is the user's decision, not a lost connection"; "the
  retry budget is configurable and zero disables it".
- `plugins/workflow/test/roles.test.ts` — "only a provably read-only role may be
  re-run after a failure" and "an unresolved profile cannot be proven safe".

Proved: dropping the `isReadOnlyRole` gate fails "a child that can write is
never re-run blind" (the executor is called twice and the call resolves instead
of throwing). Treating every failure as transport-class fails "repeating the
failure would only reproduce it": the `agentTimeoutMs` message re-runs a child
that would hit the same cap.

Full workspace: 713 pass, 0 fail (277 in the workflow suite); typecheck clean on
every package; the regression-notes verifier accepts this tree.
