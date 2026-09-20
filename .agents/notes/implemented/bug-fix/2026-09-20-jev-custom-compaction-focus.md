# Agent Note: Jev compaction honors manual focus

Status: implemented

## Problem

Pi passes `/compact` instructions to `session_before_compact` as
`customInstructions`, but jev-compact ignored that field. Jev therefore judged
tool results using only the inferred recent goal, even when the user explicitly
asked compaction to preserve a different subject or exact output.

## Decision

The hook appends non-empty custom instructions to the inferred conversation goal
as an explicit additional compaction focus before sending every Jev window.
Automatic compaction is unchanged because Pi supplies no custom instructions for
that path.

## Alternatives considered

**Replace the inferred goal with the custom text.** This honors the focus but
removes the current task that gives the focus meaning.

**Insert the instructions into transcript history.** That makes an instruction
look like another user turn and permanently copies control text into the stored
summary.

## Consequences

Every request carries a small repeated goal suffix. In exchange, manual
compaction has the same additional-focus semantics as Pi's default compactor and
Jev can retain results relevant to the user's explicit request.

## Verification

- `plugins/jev-compact/test/hook.test.ts::jev_custom_compaction_focus`

Proved: ran the test before forwarding `customInstructions`; Jev's goal contained
only `recent question`, so the focus assertion failed, then passed after the fix.
