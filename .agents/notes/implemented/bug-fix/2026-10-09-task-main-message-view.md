# Agent Note: Switch the main message area when inspecting tasks

Status: implemented

## Problem

Task navigation opened an overlay instead of replacing the parent message
view. Disabling overlay alone still replaces only Pi's editor dock. The
transcript also reused a human-readable raw-log reader that truncates long
JSON records, silently losing complete assistant replies.

## Decision

A shared run-core adapter targets Pi 1.x's document and dock component tree.
It changes document rendering while retaining the parent component children,
hides adjacent parent status/widgets, and borrows keyboard focus through a
non-overlay custom component. Closing restores rendering and the editor.
The adapter guards the host tree shape rather than depending on module identity.

Subagent main views open a sole child's Markdown transcript immediately;
multiple children use a stable-id list followed by Enter into messages.
Esc returns through the list to the parent; q always returns to the parent.
The viewport follows live messages until the user scrolls away, End resumes
following, and resizing updates its row budget. Background commands use the
same main-view adapter.

Structured transcript reads retain whole newline-delimited JSON records from
a bounded 2 MiB tail, dropping partial first/last records. Raw preview limits
remain unchanged. No persisted child session is required.

## Alternatives considered

- Keep the overlay: leaves the parent visible and fails the requested navigation.
- Remove the overlay option only: changes the editor, not the message area.
- Clear or move parent components: can lose messages arriving during inspection.
- Parse truncated raw previews: long JSON cannot be recovered after truncation.

## Consequences

Parent updates continue while hidden and appear after returning. The adapter
supports Pi 1.x regular and fullscreen layouts, reserving fullscreen editor
minimum height; an incompatible host layout fails explicitly. Transcript
history is bounded rather than an unlimited session archive.

## Verification

- `plugins/subagent/test/main-view.test.ts`
- `plugins/subagent/test/panel.test.ts::main view opens a single child's transcript and Escape restores the parent`
- `plugins/subagent/test/panel.test.ts::main view selects children beyond the viewport and returns through transcript`
- `plugins/subagent/test/panel.test.ts::main transcript follows new messages until scrolling away and resizes`
- `plugins/subagent/test/plugin.test.ts::down selects the default task entry and enter opens the panel`
- `plugins/subagent/test/logs.test.ts::transcript reader preserves complete large JSON messages`

Proved: Before switching entry and transcript mode, the navigation assertion
received overlay=true and the single-child assertion received a list instead
of folded reply. Saved output: `.agents/notes-evidence/2026-10-09-task-main-view-red.txt`.
Routing structured reads through the old raw-preview reader failed the complete
assistant-text assertion (received undefined). Saved output:
`.agents/notes-evidence/2026-10-09-task-transcript-red.txt`. Both were restored
and rerun green. Native InteractiveMode tests exercise actual regular and
fullscreen renderers: parent messages hidden, live child/parent updates,
terminal resizing, Esc restoration and editor usability.

Proved: Temporarily replaced the document renderer's child lines with a marker;
`plugins/subagent/test/main-view.test.ts` failed at the assertion requiring
Child inspection in progress in the main region. Restored the renderer and
reran both native modes green. Output saved in
`.agents/notes-evidence/2026-10-09-task-native-document-red.txt`.
