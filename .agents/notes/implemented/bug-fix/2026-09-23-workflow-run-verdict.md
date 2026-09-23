# Agent Note: Stop the run listing from calling a successful run a failure

Status: implemented

## Problem

Every run in the user's history read as a failure, and two of them had not
failed at all.

`readRunSummary` derived a run's status **only** from the journal ledger:

```
okCalls === 0 && failedCalls > 0 ? "failed"
  : failedCalls > 0 ? "partial"
  : okCalls > 0 ? "completed"
  : "unfinished"
```

So a run that finished, returned its value, and was delivered into the
conversation read as `partial` the moment one child call inside it failed. That
is exactly what the two most recent runs did:

- `wf_54889b6d276545dc` — `progress.json` says `completed`; delivered a full
  result; listed as `partial 5 ok, 1 failed`.
- `wf_6b0efc9300ac45fa` — `progress.json` says `completed`; listed as
  `partial 4 ok, 2 failed`.

The status word contradicted the result the user was already holding, and
because *any* lost agent downgrades the whole run, no run that lost one call
could ever show as successful. The code even had the verdict in hand: it read
`progress.json` only when the journal was empty.

The same read produced two other verdicts worth naming: `wf_7fd0fc643bb94800`
was listed `failed` with `0 ok, 6 failed` — correct — while
`wf_df23fb98a7f443b`'s ledger said `failed` and its snapshot said `aborted`
(the user stopped it), which the listing had no way to express.

## Decision

**The run's own verdict decides; the ledger vetoes.** `progress.json` is written
by the orchestrator with the status the script actually ended with, so it is the
run's verdict. It is now read for every run, not only unjournaled ones, and
`runStatusFrom` applies three rules:

- no snapshot → the ledger derivation, unchanged, where `partial` remains the
  only honest word for a run that produced some results and lost others (the
  shape a killed process leaves behind);
- `running` → `unfinished`, because the run never reached an end and partial
  success must not be promoted to `completed`;
- `completed` with **no** successful call → `failed`. A script that caught every
  error and returned has "completed" by its own account; reporting that as
  success would hide a total loss behind a status word, which is the same
  mistake in the other direction.

Everything else is reported as the snapshot worded it. Losses stay visible where
they belong — in the counts (`5 ok, 1 failed`) and in the `error:` line — rather
than being promoted into a verdict about the run.

## Consequences

A run that returned a value is reported as `completed` even when it lost an
agent, so the listing agrees with the result already in the transcript. `partial`
now appears only for a run with no snapshot, which in practice means a process
killed before it wrote one. The counts, the last error and the token total are
unchanged, so nothing that was visible became invisible: what changed is that
they no longer overwrite the run's own verdict.

## Alternatives considered

**Report `completed (1 call failed)` in the status column.** It says everything
in one field, but the counts column already prints `5 ok, 1 failed` on the same
line, and a status column that is a sentence stops being scannable — the thing
it exists for.

**Keep deriving from the journal and drop `progress.json` entirely.** The
journal is the durable record of what actually ran, which was the original
argument. But the journal records *calls*, and a run is not its calls: a verdict
is a different kind of fact, and the file that holds it was already being read.

**Treat any snapshot as authoritative, including `completed` with nothing
produced.** Simpler, and wrong: it would report a run in which every single call
failed as a success.

**Say `partial` when the script's own value is `degraded`.** The plugin cannot
see the script's return value from disk — `degraded` was the script's own field —
so this would need a new field in the snapshot. Not worth it while the counts
already carry the loss.

## Verification

- `plugins/workflow/test/progress.test.ts` — "a completed run that lost one call
  is completed, not partial" (status, both counts, and the last error kept); "a
  completed verdict with nothing produced is a failure"; "a run killed mid-flight
  is unfinished, whatever its journal says"; plus the existing journal-only
  `partial` and `failed` cases, which pin that the ledger path is untouched.
- Live check against the real run directories of the user's agents project: the
  two runs that had lost an agent now list as `completed`, the run whose calls
  all failed still lists as `failed` with `0 ok, 6 failed`, and the run the user
  stopped lists as `aborted` with its losses kept in the counts.

Proved: reverting `runStatusFrom` to the ledger-only derivation fails "a
completed run that lost one call is completed, not partial" with
`Expected: "completed" / Received: "partial"`. Treating a `running` snapshot as
absent fails "a run killed mid-flight is unfinished" the same way.

Full workspace: 713 pass, 0 fail (277 in the workflow suite); typecheck clean on
every package; the regression-notes verifier accepts this tree.

