# Agent Note: Bound attachment work and temp fallback

Status: implemented

## Problem

No aggregate attachment cap existed, and arbitrary basenames searched stale temp files.

## Decision

Cap at 20 images including existing images and 32 MiB newly attached decoded data. Only clipboard-prefixed basenames get temp fallback.

## Alternatives considered

Per-file caps do not bound totals; removing every temp fallback breaks clipboard references.

## Consequences

Excess references remain text. Ordinary basenames use cwd; clipboard fallback and dedup remain.

## Verification

- Test file: `plugins/paste-image/test/attach.test.ts`

- `plugins/paste-image/test/attach.test.ts::attachment count includes existing images and is bounded`

Proved: Before the fix 100 images were attached instead of 2 and ordinary basename fallback failed. Both regressions and aggregate bytes pass afterward.
