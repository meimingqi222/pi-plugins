# Agent Note: Use native disclosure rows for all work-status tools

Status: implemented

## Problem

Bash, Subagent, Workflow and Goal status items used a separate bordered card
with bold, wrapping titles, a large colored completion label and permanently
visible IDs/PIDs. Beside Paseo's compact Shell and Thinking rows they dominated
the transcript and long commands broke its reading rhythm. The live output
screen already used native disclosure conventions, but the parent status
renderer did not.

## Decision

Use the existing native timeline layout adapter for all four status kinds:
4 px vertical / 8 px horizontal header padding, 22 px icon space, 12 px icons,
normal-weight 14 px labels and single-line ellipsized summaries. Bash uses Shell
and SquareTerminal; other extension tools follow the host's generic Wrench
mapping. Normal rows start collapsed and have a transparent header; failures
start expanded to keep their reason visible. Completed status is muted rather
than a prominent colored badge; active labels use the host foreground and
loading opacity treatment.

Clicking the row toggles details containing the saved title, task description,
activity, task ID and metrics. Explicit disclosure choices survive status
updates. A separate terminal action opens subagent output without also toggling
details. Preserve latest-state synchronization, failure semantics, transformers
and transcript navigation. Reuse the host colors and public icon API; the SDK
does not expose the host timeline component or custom appearance metrics.

## Alternatives considered

- Adjust only the old card's colors: retains its different hierarchy and density.
- Remove execution status entirely: native tool rows cannot communicate a parked
  background task's state without a status indication.
- Make the whole row navigate to output: prevents in-place disclosure and does
  not work consistently for tools without transcripts.
- Import the private host renderer: unavailable through the public SDK and
  creates a fragile runtime dependency.

## Consequences

All four tools share the transcript's visual rhythm. Technical metadata remains
available by expansion and failures remain visible. Existing task-state behavior
is unchanged. Native default layout metrics are a compatibility adapter, not
an imported host component; custom host appearance settings remain unavailable.

## Verification

- `integrations/paseo-ui/test/card.test.tsx` — covers all four collapsed
  disclosures, one-line summaries, hidden technical metadata, default failure
  details, separate output action and latest historical task status.
- `integrations/paseo-ui/test/live-timeline.test.tsx` — retains the existing
  native layout/row/icon contract for the live child transcript.

Proved: temporarily restored the pre-fix WorkCard from HEAD and ran the compact
native disclosure tests: 0 pass / 4 fail, one failure per tool kind because
collapsed disclosure was absent and the original card remained. Restored the
new renderer; the card suite passed 11 tests, and the complete companion suite
passed 49 tests with its typecheck passing. Browser verification of the actual
React component with DOM adapters and host-family icons covered desktop and
390 px widths, command expansion, independent output navigation, explicit
expansion retained after completion, and both color themes. This is browser
adapter verification; real Paseo native rendering still needs host observation.

Full workspace gates were attempted: typecheck failed in pi-workflow because
its test used abandonedAgentDrainMs absent from ScriptHostOptions, and test
failed at pi-bg-bash's symlink-log regression. These concurrent changes are
outside the visual renderer and were not overwritten or suppressed.
