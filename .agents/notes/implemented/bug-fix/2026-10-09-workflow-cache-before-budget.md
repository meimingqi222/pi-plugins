# Agent Note: Lookup cache before live admission

Status: implemented

## Problem

The bridge refused cached calls before journal lookup after live budget exhaustion.

## Decision

Let orchestration admit live attempts after lookup. While reusable entries remain, panels use per-live-call admission instead of width preview.

## Alternatives considered

Releasing a refused reservation is too late; increasing budget assigns cost to free reuse.

## Consequences

Zero-budget cache reuse works. Resumed mixed panels may partially run; fresh panels retain whole-panel preview.

## Verification

- Test file: `plugins/workflow/test/security-budget.test.ts`

- `plugins/workflow/test/security-budget.test.ts::a cached call remains available after live token budget exhaustion`

Proved: The original test failed with token budget exhausted. Removing the panel cache guard separately failed the zero-budget cached panel test. Both pass with the fix.
