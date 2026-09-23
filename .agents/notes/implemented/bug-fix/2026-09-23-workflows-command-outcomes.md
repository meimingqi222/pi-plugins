# Agent Note: Make /workflows answer "which runs worked"

Status: implemented

## Problem

`/workflows` printed the run state so badly that a reader could not answer the one
question the command exists for. Against real runs:

```
wf_df23fb98a57f443b  recorded 3 agents 2 failed 419209 tokens
    last error: The agent was aborted
wf_7fd0fc643bb94800  failed 6 failed  Compare multi-agent workflow implementations…
    last error: 429: {"message":"No available route…, "code":"
```

Four defects, each losing information a reader needed:

1. **`recorded` was not an outcome.** A run that produced 1 result and lost 2 was
   labelled `recorded`, which says nothing. `partial` — some results, some losses —
   is the case that actually happens, and nothing named it.
2. **No ok/failed split.** `3 agents 2 failed` states a total and a failure count
   but never how many *succeeded*, so `partial` could not be inferred.
3. **No duration and no time of day.** A 35-second failure and a 12-minute one were
   indistinguishable, and nothing said when a run happened.
4. **The history vanished while a run was live.** The command handler returned
   after showing active runs, so exactly when a reader wants the previous
   outcomes — a run in flight — they saw nothing but the current one.

Two smaller ones: an inline script's leading comment (a task description) was
printed as the run's name next to its id, and a long provider error was cut at a
hard character count that landed inside a trailing JSON body, leaving a dangling
brace with no marker.

Finally, runs that predate failure journaling showed `empty`, which reads as
"this run did nothing" rather than "this run left no journal".

## Decision

**Derive a real outcome, and print the split that answers the question.**

- `WorkflowRunStatus` is `completed | partial | failed | aborted | unfinished |
  empty`, derived from the journal's own entries: zero successes with failures is
  `failed`, any failure alongside a success is `partial`, all successes is
  `completed`.
- A run whose journal is empty is reported from its `progress.json` snapshot
  instead — that is the other record that a run did anything, and it carries the
  same fields (agents, tokens, timestamps). Only a run with neither is `empty`.
- The row is `runId  when  status  calls  tokens  duration`, plus the `error:` line.
  Calls are `N ok, M failed`; tokens get separators; duration is `m ss` / `h mm`.
- The command shows active runs **and then** the history, rather than one or the
  other.
- A script comment that reads like a task description is not printed as a name.
- An error is cut at a word boundary and marked with `…`, and the trailing JSON
  body is dropped whole rather than mid-token. The store keeps 400 characters so
  the formatter is the only place that cuts: a store that cut first would leave
  the marker off, because a string already at the formatter's bound is returned
  unchanged.
- `empty` runs are explained once as a legend, not once per run.

## Alternatives considered

**Keep the totals and let the reader infer.** The information is already implied by
`3 agents 2 failed` — but inferring it is the reader's work, and the status word is
what makes a scan fast.

**Show only active runs when something is live.** The old behaviour, and wrong for
the stated reason: a run in flight is when the previous runs matter most.

**Truncate the error at the store.** It is what the code did, and it silently
defeated the formatter's marker. Cutting in exactly one place is the fix.

## Consequences

`/workflows` now answers the question it is asked, and the answer survives a
session that has ended. A run that produced some results is visible as such rather
than being lumped into "recorded", and a provider rate-limit failure is legible
without a dangling JSON fragment.

The summary's field set changed: `agentCalls` became `okCalls`, `status` is a
union rather than `string`, and `durationMs` was added. The in-memory `formatRun`
(active-run lines) is unchanged, so the two surfaces still read the same way.

## Verification

- `plugins/workflow/test/progress.test.ts` — the outcome word and the ok/failed
  split; an unjournaled run reported from its progress snapshot; a long error cut
  at a word boundary and marked; a task description not printed as a name; the
  empty-run legend printed once
- `plugins/workflow/test/plugin-wiring.test.ts` — active runs and the history are
  both shown

`224 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: two red runs.

- **The outcome derivation collapsed** (everything non-failure reported as
  `completed`). It failed
  `workflow run summary > reports failures alongside successes and the last error`
  with `Expected: "partial", Received: "completed"` — the case nothing named.
- **The history skipped while a run was active.** It failed
  `workflow control > /workflows reports active runs and keeps the history` with
  `Expected to contain: "Recent runs"`, and the received notice was the active list
  alone.
