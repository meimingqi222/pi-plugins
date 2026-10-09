# Agent Note: Select task categories before opening TUI panels

Status: implemented
Partly-superseded-by: 2026-10-09-task-main-message-view.md

## Problem

The opt-in Down listener opened subagents immediately, could consume dialog
navigation, and provided no equivalent for background commands. Users could
not choose a task category near the editor before opening a view.

## Decision

A run-core navigation service discovered through Pi's event bus owns one
below-editor selector and input listener across independently installed
plugins. Down highlights a category from an empty editor; Up/Down switches,
Enter opens its task view, and Escape returns to input. Dialog events, overlays,
non-editor focus and key releases keep their keys. Each plugin clears its
participation on teardown. Background tasks gain an identity-based panel with
bounded live output, scrolling, and an explicit stop key.

## Alternatives considered

- Separate listeners: extension installation order would win Down.
- Import one plugin from the other: defeats independent installation.
- Always consume Enter: would block normal prompt submission.

## Consequences

Navigation is enabled by default without PI_SUBAGENT_DOWN_INSPECT. Commands
and shortcuts remain usable; retained results remain inspectable. Viewing a
background command never consumes its model-facing result. Typed prompts retain
editor keys. On hosts exposing focused-component inspection, non-editor views
are also excluded; prompt events and overlay checks apply to all supported hosts.

## Verification

- `plugins/subagent/test/plugin.test.ts::down selects the default task entry and enter opens the panel`
- `plugins/run-core/test/task-navigation.test.ts`
- `plugins/bg-bash/test/panel.test.ts`

Proved: With the old opt-in listener enabled, Down opened customFactory before
Enter and failed the assertion expecting undefined. Output is saved in
`.agents/notes-evidence/2026-10-09-task-navigation-red.txt`. The updated default
navigation regression passes with the new selector.

## Superseded

The task entry remains authoritative; overlay/panel presentation is replaced
by the main-message switch described in `2026-10-09-task-main-message-view.md`.
