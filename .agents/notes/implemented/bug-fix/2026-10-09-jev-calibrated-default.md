# Agent Note: Calibrate the Jev default retention cutoff

Status: implemented

## Problem

The 0.5 default exceeded all scores in the recorded 354-decision sample.

## Decision

Use 0.2 in engine and plugin defaults, retaining overrides and explaining the existing benchmark tradeoff.

## Alternatives considered

Assuming calibrated probabilities contradicts observed scores; rescaling answers conceals upstream behavior.

## Consequences

The recorded maximum can survive. Retention increases and compression typically decreases; no new live benchmark is claimed.

## Verification

- Test file: `plugins/jev-compact/test/engine.test.ts`

- `plugins/jev-compact/test/engine.test.ts::the calibrated default can retain a measured 0.200 result`

Proved: The old default produced drop_call and failed; the new default produces keep.
