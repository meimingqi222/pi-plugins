# Agent Note: Keep a separate plan for each goal

Status: implemented

## Problem

Every goal in a session wrote the same `goal-plan.md`. A later goal overwrote the mutable checklist that an older history branch still referenced. Restoring the older branch could then show the later goal's steps and an apparent acceptance-criteria edit.

## Decision

Name new plan files by the goal's ID. Keep the stored `planPath` authoritative when restoring older snapshots, including snapshots that reference the legacy shared path.

## Alternatives considered

**Copy the plan on branch restoration.** The overwritten original is already lost, so copying cannot recover it.

**Store the whole checklist in session snapshots.** This would duplicate mutable file state at every boundary and make edits outside the plugin hard to reconcile.

## Consequences

New goals no longer overwrite an earlier goal's plan. Existing snapshots still read their previously recorded paths; a legacy shared plan already overwritten before this fix cannot be reconstructed.

## Verification

- `plugins/goal/test/plan.test.ts`
- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/plan.test.ts::separate goals in one session keep separate plan files`
- `plugins/goal/test/lifecycle.test.ts::an old goal branch retains its plan after a later goal is created`

Proved: the path test returned the same path for two IDs before the change and different paths after it; the branch test confirms the earlier file retains its contents.
