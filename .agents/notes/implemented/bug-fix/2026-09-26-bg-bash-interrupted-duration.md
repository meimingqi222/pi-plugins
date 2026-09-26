# Agent Note: Do not invent an end time for a restored interrupted job

Status: implemented

## Problem

Restoring a session turned a still-`running` job record into `interrupted`, but
`JobRegistry.restore` filled `endedAt` with `Date.now()`. The duration shown by
`bg_tasks status` / `result` then counted the idle gap since the crash as if the
process had kept working, and `result` reported that invented timestamp as
`Ended:`. A short `sleep` killed by a reload could appear to have run for hours.

## Decision

Keep `endedAt` only when the record already had one. Display helpers report
`unknown` for a job with no honest end and status other than `running`; a live
job still shows growing elapsed time, and a terminal record with `endedAt` still
shows the real span. `Ended:` is `still running` only for status `running`.

## Alternatives considered

**Keep `endedAt = Date.now()` at restore.** Simple, but the number is a lie and
the most misleading dimension is the one agents and people read first.

**Treat missing `endedAt` as `now` in every formatter.** Makes the label drift
while the session sits open, and still overstates the process lifetime.

## Consequences

An interrupted job's runtime is simply unknown unless a terminal record
survived. Callers that used `durationMs` on such a job for non-display purposes
would still see `now - startedAt`; the UI path goes through `formatElapsed` /
`formatEndedAt` instead. The completion-entry renderer also uses
`formatElapsed`, so it cannot show a contradictory `0.0s` for an interrupted
record with no end time.

## Verification

- `plugins/bg-bash/test/jobs.test.ts` — restore keeps a missing end missing and
  preserves a real terminal `endedAt`
- `plugins/bg-bash/test/plugin.test.ts::a formerly running job is restored as interrupted, not live`
- `plugins/bg-bash/test/render.test.ts::an interrupted record without an end renders unknown duration`

Proved: before the fix, that plugin test's `status` text included a positive
elapsed duration for a restored `sleep 5` job. After the change,
`bun test plugins/bg-bash` ran `98 pass, 0 fail`. Before the renderer fix,
`bun test plugins/bg-bash/test/render.test.ts -t 'an interrupted record without an end'`
failed because the TUI showed `0.0s`; after the renderer uses `formatElapsed`,
the test passes.
