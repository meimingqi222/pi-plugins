# Agent Note: Give subagent children a liveness surface the user can watch

Status: implemented
Partly-superseded-by: 2026-10-09-task-keyboard-navigation.md

## Problem

A background `subagent` call was invisible to the user until it settled.

1. The only surfaces were model-facing: `subagent_tasks` is a tool the model
   calls, and `subagent_result` is a push message that arrives at settlement.
2. The tool card cannot be a live view: `background: true` returns immediately,
   so `renderResult` is final at launch and `onProgress` never reaches it.
3. A session looked idle while four children ran — the same gap
   `implemented/feature/2026-09-23-workflow-liveness-surfaces.md` recorded for
   `pi-workflow`.
4. `formatBackground`'s "possible stall" existed only as text the model had to
   ask for.

Reference implementations examined: Step-Code's `subagent/rendering.ts` +
`lane-lifecycle.ts` (stable widget rows, per-lane widgets, throttled lane
notifications, subscribe levels) and minimax-code's `tui/background-work/
panel.ts` + `shell/task-panel.ts` (a deliberate full-screen panel with
stable-key selection, contextual Esc, kind-dependent Enter, a summary header
that encodes the worst state, and a composer-adjacent counts line). The design
is recorded in `proposed/architecture/2026-09-27-subagent-fleet-surfaces-design.md`.

## Decision

One renderer, three surfaces, all sharing `deriveChildState`.

**`src/background.ts`** gains `deriveChildState(record, now)` →
`running | stalled | completed | failed | aborted`, where `stalled` = running
and quiet ≥ `QUIET_ACTIVITY_WARNING_MS` (90s). `formatBackground` calls it, so
the model's text and the widget's icon cannot disagree. `hasActive()` exposes
the running count for the reporter's lifecycle.

**`src/fleet.ts`** is pure: records + `now` in, display columns out. Widget
rows are stable — icon, agent, task, elapsed, a fixed-width `elapsed · ↓tok`
metric column — and deliberately omit the live tool call, which Step-Code
measured as unreadable churn in a persistent surface. `fit()` clips by
`visibleWidth` with a plain `…` (not `truncateToWidth`, whose ANSI-wrapped
ellipsis clears the row's own colour mid-line; not `truncateText`, which
appends its marker as a second line). The widget caps at `WIDGET_MAX_ROWS = 6`
plus `… N more`. The panel row keeps the live detail: `› ● <task> · agent ·
tool grep x · 3m`.

**`src/widget.ts`** — `createFleetReporter` claims a below-editor widget slot
only while children run: mounted on the first live launch, unmounted
(`setWidget(key, undefined)`) on the last settlement, one `unref`'d 1s interval
between the two, cleared in `dispose()`. The tick does one thing —
`tui.requestRender()` — because `render()` reads the clock itself and
`setProgress` already keeps records fresh per event. The mounted component is
reused across repaints; nothing is republished. On each tick a child newly
crossing into `stalled` fires one `notify("warning")` per id.

**`src/panel.ts`** — `ctx.ui.custom(..., { overlay: true })`. `↑`/`↓` select by
record id (selection survives the active→settled reorder that settles cause),
`enter` opens a detail (task, bounded activity trail, usage, result/error,
metadata only), `l` opens a bounded raw-log tail through the existing
`readSubagentLog` (explicit — the log contains prompts), `k` cancels a running
child, `r` repaints, `q`/`Esc` close, `Esc` in detail returns to the list.
Scrolling is self-managed (`BODY_ROWS` + offset) because overlay components
receive only a width and the host clips from the top. A child that vanishes
mid-view shows "task unavailable · Esc to return". The panel's interval is
`unref`'d and cleared in `dispose()`; `endSession` disposes it explicitly
because the host removes overlays without calling `dispose`.

**`src/index.ts`** — `/subagents` prints the listing (`live` opens the panel;
`stop [id]` cancels; `<sa-id>` shows one), `ctrl+shift+a` opens the panel,
`PI_SUBAGENT_DOWN_INSPECT=1` opens it on `down` at an empty editor. `uiCtx` is
refreshed on `session_start` and lazily at launch (a `/reload` mid-session
swaps the extension in without another `session_start`); `endSession` drops it
and tears the panel down. `hasUI` and `mode === "tui"` guard every surface.

## Alternatives considered

- **Live tool call in the widget row.** Step-Code removed exactly that after it
  churned every row per delta and republished the widget per keystroke. Live
  activity lives in the panel, which the user opens on purpose.
- **One widget per child** (Step-Code's lanes). A bounded aggregated fleet fits
  the shared widget area; per-child widgets would not.
- **Footer `setStatus`.** `pi-workflow` already owns a footer slot; one line
  cannot carry four children; `setWidget` is the documented surface for content
  near the editor.
- **`down` as the default open key.** It browses history at an empty editor,
  and a TUI-level input listener runs before dialog focus, so it can eat `down`
  aimed at an open selector. Flag-gated instead.
- **Reopen a child session for the detail view.** Children spawn with
  `--no-session`; there is no transcript file to reopen. The bounded log tail
  answers "what did it do" without changing the spawn contract.
- **Persistent task rows / `lost` reconciliation** (minimax). Requires durable
  children; out of scope for the current `--no-session` design.
- **Publish-on-event with a signature** (Step-Code). Unneeded once the widget
  is a mounted component: a repaint costs a `requestRender`, not a teardown.

## Consequences

A running fleet is visible without asking; `/subagents` and `ctrl+shift+a` are
the discoverable entry points; a stall announces itself once. `formatBackground`
now derives stall from the same function the widget uses. The model-facing
surface is unchanged. `formatFleetSummary` computes the eldest child with
`Math.min(startedAt)`, not `Math.max`: the first version read the newest start
as "oldest" and reported `0s` for a five-minute-old fleet.

## Verification

- `plugins/subagent/test/fleet.test.ts` — `deriveChildState` threshold and
  settled passthrough; the `formatBackground`/widget stall agreement; `fit`
  display-column clipping with CJK; widget row stability, bounded rows, and
  `… N more`; the panel row's live detail and selection rail; detail bounds.
- `plugins/subagent/test/widget.test.ts` — mounts only while active, hands the
  slot back, `unref`'d interval, once-per-child stall notification, a settled
  child never notifies, idempotent dispose, and no mount without a UI context.
- `plugins/subagent/test/panel.test.ts` — list rendering, id-pinned selection
  across a reorder, enter→detail→Esc→close layering, vanished-child tombstone,
  `k` cancels only running children, `l` bounded log, scroll clamp, key-release
  ignored, width fits at 10/24/40/80, `dispose` stops the ticker.
- `plugins/subagent/test/plugin.test.ts` — `/subagents` + shortcut registered;
  a TUI launch mounts the widget and settlement unmounts it; a non-TUI launch
  mounts nothing; `PI_SUBAGENT_DOWN_INSPECT` consumes `down` at an empty editor
  and leaves it alone otherwise.

Proved: reverting `deriveChildState` to always `running` fails five tests
(threshold boundary, stall agreement, fleet summary counts, the once-per-child
stall notify, and the no-progress stall) and `formatBackground` loses its
"possible stall" marker. Reverted; all 70 plugin tests pass, `bun run
typecheck` is clean.

## Superseded

The opt-in Down-to-open decision is replaced by the shared default Down/Enter
category selector in 2026-10-09-task-keyboard-navigation.md. Widget, panel,
shortcut and lifecycle behavior described here otherwise remains applicable.
Active duration accounting is now owned by 2026-10-09-subagent-active-duration.md.

The overlay and Enter-to-detail presentation is superseded by
`2026-10-09-task-main-message-view.md`: main task navigation now replaces the
message area, and Enter opens the selected child's transcript.
