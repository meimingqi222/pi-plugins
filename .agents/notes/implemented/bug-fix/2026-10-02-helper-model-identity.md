# Agent Note: Resolve a physical model for helper calls that must not inherit a router

Status: implemented
Partly-superseded-by: 2026-10-03-helper-current-selection.md

## Problem

pi 1.0 split the session selection from the model that answers. `ctx.model`,
`PI_MODEL` and `--model` name the *selection*; only each assistant message names
the *physical* model that produced it. A session running a virtual model
therefore has a `ctx.model` with no provider credentials of its own.

Three call sites treated `ctx.model` as the model to run on:

- `pi-goal`'s verifier (`resolveVerifierModel` → `verifyGoal`) and planner
  (`runPlanner`), both isolated calls outside the agent loop.
- `pi-permissions`' reviewer, which resolves `provider/id` through its own copy
  of the same parsing.

Sending a virtual selection to `modelRegistry.complete()` fails with an
authentication error that names a provider no one chose. The failure reads as
"the model stopped working", so a user who installed a router extension finds
their goal unverifiable with no pointer to the cause.

## Decision

`pi-run-core` gains `model-identity.ts`, the single place a helper call resolves
its model. Resolution is physical-first:

1. an explicit `spec` the user wrote, always trusted;
2. the physical model that answered the newest assistant message, when the
   registry still has it and it still has credentials;
3. the session selection, with a `reason` saying a virtual model may be in play.

`pi-goal` resolves its verifier and planner through it. `pi-permissions` shares
only `parseModelIdentity`: its reviewer keeps strict resolution, because a
permission reviewer that silently falls back to another model is worse than one
that asks.

The seam is `lastPhysicalModel(entries)`, read from the session branch. It needs
no new API, so it works against 0.85 as well as 1.x.

## Alternatives considered

**Ask pi for a resolver.** The clean fix, but nothing in the 1.0 docs exposes
one, and this repository is pinned to 0.85 where the API does not exist at all.

**Pass the selection and let `complete()` fail.** Leaves the user-facing bug in
place and adds no information.

**Have the judge inherit the router like the main loop.** An isolated judgment
call is deliberately outside the agent loop; a router's per-session state cannot
cross that boundary, and a judge whose model changes under it is not a judge.

## Consequences

A session with nothing answered yet still uses the selection — today's
behaviour, now reported instead of silent. The `reason` a user reads names the
model in play, so the one case that can still fail says so up front.

Physical-first is correct in both worlds: it is what the judge used before
virtual models existed, and after they exist it is the identity every consumer
can resolve.

### Probed against `@earendil-works/pi-coding-agent@1.0.0`

Read from the published 1.0.0 `dist`, not from docs, so the facts below are
load-bearing for this design:

- `modelRegistry.complete()` delegates to `stream()`, which calls
  `assertChatModel(model)` and `prepareRequest()` **without** an
  `isVirtualModel()` check. Only `streamSimple()` and `completeSimple()` route,
  with `reason: "direct"`. So the helper calls this repository makes
  (`run-core/isolated.ts`, `goal/plan.ts`, `goal/verifier.ts` all use
  `complete`) never route on their own.
- `hasConfiguredAuth(virtualModel)` returns **true**, not false. Registering a
  virtual model under a provider no physical model uses marks that provider
  configured (`source: "virtual"`). The auth guard in `verifyGoal` and
  `isolatedComplete` therefore does not catch a virtual selection — which is
  why the resolution, not the guard, has to change.
- A virtual catalog entry has no `type` field, and `getModelType()` defaults it
  to `"chat"`, so `assertChatModel()` passes. What fails instead is the stream
  itself: a virtual-only provider composes an `unroutedStream` that throws
  *"Virtual model p/i must be routed before streaming"*. Under a provider that
  does have credentials, the request reaches that provider with an id it does
  not have.
- `resolveModel()` refuses a virtual target (`getPhysicalModel` filters them),
  so a router cannot delegate to another router, and it throws when the target
  has no credentials.
- `findLatestResponse()` skips assistant messages whose `stopReason` is
  `error` or `aborted`, which is what `lastPhysicalModel` now matches.

The same probe measured the child-process case (see the sibling note
`2026-10-02-child-model-inheritance.md`): a child pi that did not load the router
extension fails at startup with `Model "p/i" not found`, while a child that did
load it reaches routing. Nothing between those two is observable from the parent,
which is why `pi-subagent` hands children the physical model.

## Superseded

Unconditional historical-model priority is replaced by the successor: a current
concrete selection wins over old responses. Invalid explicit specs use the same
default resolver, as recorded in `2026-10-03-helper-invalid-spec-fallback.md`.

## Verification

- `plugins/goal/test/lifecycle.test.ts::goal lifecycle > a virtual session selection is never sent to the verifier`
- `plugins/goal/test/lifecycle.test.ts::goal lifecycle > a virtual selection with no physical answer is used and says so`
- `plugins/run-core/test/model-identity.test.ts`

Proved: reverted `resolveVerifierModel` to return `ctx.model` when no spec is
set; `a virtual session selection is never sent to the verifier` failed with
`expected "openai-codex/gpt-5.6-luna", received "jev/auto"`, then passed once
the physical-first resolution was restored.
