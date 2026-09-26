# Agent Note: One background-work surface for every run-oriented plugin

Status: implemented

## Problem

After `2026-09-27-subagent-fleet-surfaces.md` shipped, four plugins answered
"is anything still running?" in four different ways — or not at all:

- `pi-goal` drew a `setStatus` footer.
- `pi-workflow` drew a `setStatus` footer and a `/workflows live` panel.
- `pi-subagent` drew a below-editor fleet widget and a `/subagents` panel.
- `pi-bg-bash` drew **nothing** while a job ran: a `bgNNN` was a completion
  notification plus `bg_tasks list` output — the same blind spot the fleet
  work had just closed for subagents.

The rendering rules the fleet shipped (stable rows, fixed metric column,
`visibleWidth` clipping with a plain ellipsis, mount-only-while-live,
tick-is-a-repaint) were about to be copied verbatim into a second plugin.
That is exactly the drift `run-core` exists to prevent.

## Decision

**`pi-run-core` gains `src/work-surface.ts`**, the shared presentation
contract for live work:

- `WorkItem` / `WorkState` — the row vocabulary: `id`, `kind` (the type
  column: agent name or `"background"`), `label` (the stable task — never the
  live tool call), `state`, `startedAt`/`endedAt`, optional `metric`. Each
  plugin keeps its own status names and maps onto the superset.
- `formatWorkRow` / `formatWorkSummary` / `renderWorkSurface` — the single
  renderer. `fitWorkText` clips by `visibleWidth` with a plain `…` (not
  `truncateToWidth`, whose ANSI-wrapped ellipsis clears the row's own colour;
  not `truncateText`, which appends a second line).
- `createWorkReporter` — the mount/tick/teardown lifecycle: claims a
  below-editor widget only while `live()`, repaints on a bounded `unref`'d
  interval (`render()` reads the clock; no republish), hands the slot back on
  the last settle, `onTick` for per-tick side effects.

**`pi-subagent`** — `src/fleet.ts` slims to the mapping (`toWorkItem`, the
`ChildState → WorkState` table) plus the two renderers the shared file does
not own (the opened panel row, the detail view). `src/widget.ts` delegates to
`createWorkReporter`; the stall notification stays here as its `onTick`,
because `stalled` is a `pi-subagent` vocabulary word — a bash job has no
activity events and can never stall. Exports are unchanged.

**`pi-bg-bash`** — `src/pi/surface.ts` maps `Job` onto `WorkItem`
(`timedout → failed`, because a process killed for overrunning its budget did
not succeed; `interrupted/killed → stopped`; pid as the running metric).
`pi/index.ts` creates the reporter, binds `uiCtx` in `session_start` *and* in
`runtime.started` (the earliest call carrying a UI context — a lazy capture
covers a tool call that precedes it), syncs on every registry `onChange`, and
adds `/bg` (`/bg` lists; `/bg kill <id>` stops).

## Alternatives considered

- **A separate `pi-bg-view` package that owns the widget and consumes every
  plugin over `pi.events`.** The right end-state for a bus (see Consequences),
  but premature while the only publishers are the two plugins here: a bus adds
  an owner-election problem this change does not have.
- **Each plugin keeps its own renderer and just matches styles.** That is the
  drift this change exists to close; matching styles is not sharing code.
- **Skip the widget for bg-bash because `bg_tasks list` exists.** That is the
  model-facing surface; a running background job is otherwise invisible to
  the user until settlement, the original complaint.
- **`timedout → stopped`** (colour-matching `renderStatusEntry`'s "warning").
  Rejected: the icon should say the outcome, not the colour it happens to
  share.

## Consequences

`pi-bg-bash` jobs are visible while running, through the same row format a
subagent child uses; `/bg` gives a listing and a kill path without a tool
call. `JobRegistry.promote` now fires `onChange`: a foreground job that
detaches becomes visible work the moment it detaches — previously no listener
could observe the transition. `fleet.ts` and `widget.ts` thin to mapping and
subagent-specific behaviour; the shared file owns every rule they used to.

**Deferred: the bus.** `pi.events` service so `pi-goal`, `pi-workflow`, and a
future `pi-bg-view` publish `WorkItem`s to one owner widget — worth doing when
a third plugin needs the surface; until then each plugin owns its widget, and
the interim state is two stacked widgets when both run (bounded, acceptable).

**Deferred: child transcripts.** `enter` on a subagent row renders the
session's own JSONL log; a real child transcript needs durable child
sessions, which is a lifecycle decision (`--no-session`), not a surface one.

## Verification

- `plugins/run-core/test/work-surface.test.ts` — the shared row (stable
  label, pinned `endedAt` elapsed, wide-character width fit, bounded rows +
  `… N more`), the shared summary (counts, worst-state marker, eldest-age
  `Math.min`), `fitWorkText`/`formatWorkElapsed`/`formatWorkTokens`, and
  `createWorkReporter` (slot claim only while live, `unref`'d timer, `onTick`
  while mounted, idempotent dispose, no mount without a UI).
- `plugins/bg-bash/test/surface.test.ts` — the `Job → WorkItem` mapping for
  every status, `runningWorkItems` filters foreground and settled jobs out,
  `/bg` listing format, and `promote` firing `onChange`.
- `plugins/subagent/test/fleet.test.ts` and `widget.test.ts` — unchanged;
  `fleet.ts` re-exports keep the row/summary contract identical through the
  shared renderer.

Proved: reverting `promote`'s `changed()` call fails the `onChange`
regression test, and a foreground job that detaches would mount no widget.
Reverted; `pi-run-core` 38 pass, `pi-subagent` 70 pass, `pi-bg-bash` 107
pass, `bun run typecheck` clean.
