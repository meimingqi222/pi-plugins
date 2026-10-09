# Agent Note: Make run directories private

Status: implemented

## Problem

0600 workflow files lived in directories created as 0755 under typical umask.

## Decision

Create directories as 0700 and tighten an existing run directory on POSIX during journal open.

## Alternatives considered

Ambient umask is unreliable; file modes leave directory metadata traversable.

## Consequences

Directory contents and metadata are protected. POSIX tests do not claim Windows ACL behavior.

## Verification

- Test file: `plugins/workflow/test/security-budget.test.ts`

- `plugins/workflow/test/security-budget.test.ts::workflow run directories are private regardless of umask`

Proved: The test observed 0755 before the fix and 0700 afterward on macOS.
