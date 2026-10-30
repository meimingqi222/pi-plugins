# Agent Note: One visual language for work state across terminal and web

Status: implemented

## Problem

The same work state machine was rendered three different ways, so one child
could be described three ways in one session:

- `pi-run-core`'s `WORK_ICONS`: `· ● ◌ ◉ ✓ × ■` with five theme colours.
- `pi-subagent`'s `{{SECRET_l6neygg}}` renderer: its own private
  `✗ / ● / ✓` markers.
- the Paseo companion's `work-card.tsx`: Lucide icons plus fifteen raw status
  strings flattened into eight English labels (`Cancelled`, `Timed out`,
  `Interrupted`, `Budget reached`, `No progress`, …).

Two of these were outright defects rather than mere inconsistency:

1. **`✗` is not one column wide** in plenty of terminal fonts, so every indented
   line under a failed tool in the `{{SECRET_l6neygg}}` view shifted — while the
   fleet widget rendered the same state as `×`.
2. **Expanding a Paseo card destroyed its identity.** `work-card.tsx` rendered
   `<Icon name={expanded ? "ChevronDown" : failed ? "CircleAlert" : tool.icon}>`,
   so the leading badge became a chevron at the exact moment the card grew, and
   nothing on screen said whether the row was Shell, Subagent, Workflow or Goal.
   The same map also sent Subagent, Workflow and Goal all to `Wrench`.

A third defect sat next to them: a failed card opened by default, so a run of
consecutive failures stacked expanded cards and pushed earlier context off the
timeline.

## Decision

**Terminal: the shared glyphs, not a private set.** `renderTranscript` imports
`WORK_ICONS` from `pi-run-core` and renders `failed` / `running` / `succeeded`
from it. The colours stay local — they are the `{{SECRET_l6neygg}}`'s own
semantics — but the glyph is the one the fleet widget already shows.

**Web: fifteen raw states collapse to the seven the terminal renders**, through
one `STATUS_TO_WORK` table and one `WORK_LABELS` table in `work-card.tsx`.
`succeeded` reads `Done` rather than `Completed`, `timedout` and `no_progress`
read `Stalled`, `aborted` / `killed` / `interrupted` read `Stopped`, and
`budget_limited` / `blocked` read `Failed`. The tool's own icon leads the row
unconditionally; the disclosure chevron moves to the trailing edge. Cards start
collapsed, failures included, and a collapsed failure carries a one-line red
summary instead of the whole body. Metadata reads `ID: …` and `Usage: …` rather
than a bare `id · metric` join, because `↓1.2k` alone does not say what it
counts.

**`WorkState` is declared in `integrations/paseo-ui/shared/work-status.ts`
rather than imported from `pi-run-core`.** Nothing in this workspace is
published to a registry, so that is not the reason. The reason is the
dependency chain: `pi-run-core` depends on `@earendil-works/pi-tui`, and
`integrations/paseo-ui` cannot even resolve `@earendil-works` — its
`node_modules` holds only the `pi-subagent` workspace link. Importing a string
union would drag pi's TUI into the Paseo daemon process. The duplication is
deliberate and the comment at the declaration says so.

## Alternatives considered

- **Import `WorkState` from `pi-run-core` in the companion.** Rejected for the
  dependency reason above.
- **Keep failed cards expanded by default.** Rejected: it is the information
  avalanche. The one-line failure summary is what the collapsed row needs.
- **Keep fifteen distinct labels.** Rejected: they are not fifteen distinct
  things. `exited(0)` and `complete` and `completed` are one outcome, and a user
  should not have to learn which spelling a given surface picked.
- **Emoji status glyphs in the terminal.** Rejected: the TUI's existing
  vocabulary is austere and the repo has no emoji in it.

## Consequences

- `Completed` no longer appears anywhere in the companion; `Done` does. Any
  external text matching on the old labels changes meaning.
- A collapsed failed card shows the activity's first line only; the full body is
  one keypress away, as it is for every other state.
- `native-timeline-style.ts`'s `marginHorizontal: -13` was left in place but
  named `HOST_EDGE_COMPENSATION` and documented as host-derived. It could not
  be verified visually here, and silently changing a pixel alignment that
  currently matches the host would be a worse trade than documenting it.

## Verification

- `plugins/subagent/test/transcript.test.ts` — `a failed tool uses the
  shared one-column glyph, not a private one` and `a finished tool and a running
  one use the shared glyphs too`.
- `plugins/subagent/test/panel.test.ts` — `a streaming {{SECRET_l6neygg}}
  carries a cursor on its last line`; `a finished {{SECRET_l6neygg}} with no
  events says why, instead of waiting forever`; `the footer leads with the way
  out, so a narrow pane cannot cut it`.
- `integrations/paseo-ui/test/card.test.tsx` — the icon mock now exposes the
  icon name (`data-icon`), without which none of this was pinnable;
  `the tool's own icon leads the row and the disclosure chevron trails it`;
  plus the rewritten label expectations in the disclosure, state and historical
  card tests.
- Red-run proof: `regression-evidence/state-language-red.txt` — the
  `✗`/`Wrench`/`Completed` assertions failed before the change.

Proved: regression-evidence/state-language-red.txt — with the private ✗/●/✓ markers restored, `a failed tool uses the shared one-column glyph, not a private one` fails (`Expected to contain: "×"` / `Received: "  ✗ bash(git push -f)"`).
