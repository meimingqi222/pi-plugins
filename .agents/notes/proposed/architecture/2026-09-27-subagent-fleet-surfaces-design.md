# Agent Note: Give subagent children a liveness surface the user can watch

Status: proposed

## Problem

A background `subagent` call is invisible to the user until it finishes.

1. **The only surfaces are model-facing.** `subagent_tasks` is a tool the model
   calls; the human cannot invoke it. `subagent_result` is a push message that
   arrives only at settlement.
2. **The tool card cannot be a live view.** `background: true` returns
   immediately, so `renderResult` is final at launch — the card in scrollback is
   a snapshot of "launched", and the child's `onProgress` never reaches it.
3. **A session looks idle while four children run.** Exactly the gap recorded
   for `pi-workflow` in
   `implemented/feature/2026-09-23-workflow-liveness-surfaces.md`.
4. **Stalls are model-only text.** `formatBackground`'s "possible stall" appears
   only when the model calls `subagent_tasks`, or at delivery.

## Proposal

One renderer, three surfaces, mirroring `pi-workflow`'s liveness design.

**`src/fleet.ts` — pure state + formatting.** `deriveChildState(record, now)`
returns `running | stalled | completed | failed | aborted` from a record and a
clock; `stalled` = running and quiet ≥ `QUIET_ACTIVITY_WARNING_MS` (90 s), the
same threshold `formatBackground` already uses — refactored to call it, so the
model's text and the widget cannot disagree. The state fields are metadata only
(agent, task, status, elapsed, phase, token count); `setProgress` already keeps
`record.progress` fresh per child event, so no new event path is needed.

**A below-editor widget, mounted only while something is live.** A reporter
(claim/sync/dispose, same shape as workflow's `createFooterReporter`) mounts one
component the first time a child is running and unmounts it — `setWidget(key,
undefined)` — on the last settlement. Rows are **stable**: icon + agent + task +
elapsed + output tokens, in a fixed-width metric column. No live tool call, no
streamed text: Step-Code removed exactly that from its widget after it churned
every row per stream delta. Elapsed advances because the component ticks
`requestRender()` once a second — `unref`'d, cleared in `dispose()`, owned only
between first launch and last settlement. Unlike Step-Code's signature-based
publish dedupe, a mounted component only needs `requestRender` (a repaint), not
`setWidget` (a teardown+republish), so a signature is unnecessary here.

**`/subagents` + panel (TUI only).** `/subagents` prints a bounded listing
(reusing `formatBackground` lines); `/subagents live` opens an overlay panel via
`ctx.ui.custom(..., { overlay: true })`, modeled on `panel.ts`. Keys:
`↑`/`↓` select (stable key preserved across re-renders, defaulting to the
newest active child — minimax's `syncSelection`/`activeAgentKey`), `enter`
opens a detail view, `l` reads a bounded raw-log tail via the existing
`readSubagentLog` (explicit opt-in — it contains prompts), `k` cancels via
`registry.stop`, `r` repaints, `q`/`Esc` close, `Esc` in detail returns to the
list. A vanished child renders "task unavailable · Esc to return" rather than
stale content.

**A once-per-child stall notification.** On the widget's tick, a child crossing
into `stalled` fires one `notify("warning")` per record id, cleared on settle.
TUI-only: RPC clients cannot show a widget anyway, and the model has
`subagent_tasks`.

**`ctrl+shift+a` shortcut** opens the panel (guarded to TUI, no-op with an
empty fleet). `PI_SUBAGENT_DOWN_INSPECT=1` additionally opens it when the user
presses `down` while the editor is empty — behind a flag because it swallows a
core keybinding (history browsing) and a TUI-level input listener runs before
dialog focus, so it can steal `down` from an open selector.

## Acceptance criteria

- A `background: true` launch mounts a below-editor widget that shows one
  stable row per child and disappears when the last child settles.
- `/subagents` prints the same listing `subagent_tasks` produces;
  `/subagents live` opens the panel with ↑/↓/enter/k/l/q/Esc navigation.
- A child quiet for 90s renders `stalled` (◉) in the widget, reports
  "possible stall" in `subagent_tasks`, and notifies the user once.
- Non-TUI modes mount nothing and keep every model-facing tool unchanged.

## Risks

- The widget's tick is owned by the reporter; a leak on session teardown would
  keep a timer alive across sessions. `endSession` disposes the panel and
  reporter explicitly because the host drops overlays without disposing them.
- `registerShortcut` claims `ctrl+shift+a` globally inside pi; a conflict is a
  diagnostic, not a crash, and the widget's hint line advertises `/subagents`
  as the always-available path.
- Extension embeddings that lack `registerCommand`/`registerShortcut` (tests,
  RPC drivers) are tolerated by optional calls — the tools keep working.

## Alternatives considered

- **Live tool call in the widget row.** Rejected (Step-Code's measured churn:
  "the column churned too fast to read and each change dragged the host through
  another republish and redraw"). Live activity belongs in the panel detail.
- **One widget per child** (Step-Code's background lanes). Rejected: a fleet
  summary + bounded rows fits the shared widget area better than unbounded
  per-lane widgets; the panel supplies per-child depth.
- **Footer status** (`setStatus`). Rejected: `pi-workflow` owns a footer slot
  already, one line cannot carry four children, and `setWidget` is the surface
  the docs name for content near the editor.
- **Reopen a child session for the detail view.** `agent-runner` spawns children
  with `--no-session`, so there is no transcript file to reopen; the bounded
  raw-log tail answers the same "what did it do" question without changing the
  spawn contract. A resumable child would be a separate decision.
- **Unify with `bg_tasks` into one background-work list** (minimax does).
  Deferred: cross-plugin state needs an `pi.events` service (the pattern
  `pi-redact`/`pi-jev-compact` already use), not part of this change.
- **`down` as the default open key.** Rejected above; flag-gated instead.
- **Per-child `sessionId` / `keepAlive` child** (Step-Code replies, minimax
  transcript). Out of scope: the one-level, `--no-session` contract stands.

## Consequences

A running fleet is visible without asking, and inspecting it needs only
`/subagents` or `ctrl+shift+a`. Stalls surface for the human without a model
round-trip. The widget borrows workflow's timer discipline (owned interval,
`unref`, `dispose`), and the panel borrows its key handling (`isKeyRelease`,
`truncateToWidth`, `dispose` on close). The model-facing surface is unchanged:
`formatBackground` now shares the state derivation, so model text, widget and
panel describe the same child the same way.
