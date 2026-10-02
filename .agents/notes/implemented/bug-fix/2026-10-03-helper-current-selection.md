# Agent Note: Honor the current concrete model selection

Status: implemented

## Problem

Historical physical-answer priority ignored a user's switch to another concrete
model until that model answered. A goal planner or child could still run on the
previous model immediately after the switch.

## Decision

Use the current concrete selection directly. Only a virtual selection needs the
physical-answer lookup. Children inherit a concrete selection without a virtual
fallback warning. This replaces the unconditional history priority in
`2026-10-02-helper-model-identity.md` and
`2026-10-02-child-model-inheritance.md`.

## Alternatives considered

Reading only model_change entries adds a second copy of selection reconstruction
and cannot see a changed selection before persistence. The context already
contains the selected model and its API identity.

## Consequences

Switches take effect for helper calls immediately. Virtual selections continue
to use their physical answers; valid explicit helper specs still win.

## Verification

- `plugins/run-core/test/helper-model-fallback.test.ts`
- `plugins/run-core/test/helper-model-fallback.test.ts::a newly selected physical model overrides historical answers for helpers and children`

Proved: before the fix the test returned openai/physical instead of the selected
anthropic/new-selection; after the fix helper and child assertions pass.
