# Agent Note: Let the verifier run on a configured model

Status: implemented

## Problem

The verifier and the implementer were the same model. The verifier already had an
isolated conversation — `verifyGoal` builds a fresh `messages` array, so the
implementer's own reasoning never leaks in — but isolation of *context* is not
isolation of *judgment*. A model asked to grade work it just produced shares its
own blind spots, and the one thing it reliably fails to catch is the mistake it
just made. No amount of transcript-isolation fixes that, because the correlation
is in the weights, not in the prompt.

There was no way to point verification at a different model, so a user could not
trade a cheap implementer for a strong judge, or the reverse.

## Decision

`PI_GOAL_VERIFIER_MODEL`, as `provider/modelId`, selects the judge. Unset is the
default and resolves to the session's active model, so nothing changes until it
is configured. `resolveVerifierModel` is the single resolver:

- **A spec without a `provider/` prefix is ignored.** A bare id can exist on
  several providers, and picking one arbitrarily would silently verify with a
  model the user never named.
- **An unknown id falls back to the active model**, with a warning. A typo must
  not make a goal unverifiable, which is a worse failure than verifying with the
  default model.
- **A model without configured auth falls back the same way**, for the same
  reason: the alternative is throwing on every round.

The model is resolved by the caller and passed into `verifyGoal` rather than
looked up inside it, so the id recorded on the snapshot is guaranteed to be the
one that actually judged, rather than a second lookup that could drift.

The fallback warning fires once per goal, not once per round. A fallback is a
standing configuration state, so repeating it every verification round would be
noise; it is keyed by goal id, so a replace re-announces and a resume does not.

`goal.verifierModel` is stored on the snapshot. A verdict is a model judgment,
and the same transcript can be judged differently by a different model, so
"which model said this" is part of the record.

## Alternatives considered

**Fail closed on a bad spec — pause the goal.** Surfaces the misconfiguration
loudly, but it means a typo in an environment variable stops the user's work.
The warning plus the recorded model id gives the same visibility without
blocking.

**Accept a bare model id and resolve it against the registry.** Convenient, but
the registry can legitimately hold the same id under several providers; the
choice would be silent and arbitrary, and the user would find out from the
verifier's behaviour rather than from a message.

**Let the configured model replace the active model for the whole session.**
That is what `/model` already does, and `/goal resume` would then inherit it.
This setting is deliberately narrower: it changes the judge, not the worker.

**Route the planner through the same setting.** The planner shapes the acceptance
criteria rather than judging them, so a shared blind spot there is less costly
than in the judge. Kept scoped to verification, which is what the environment
variable names.

**Run the verifier with tools so it can read the workspace.** The larger prize,
but `complete()` is a single call, and pi's extension API exposes no way to
execute a tool — the reference implementation (`examples/extensions/subagent`)
spawns a whole `pi` subprocess to get one. That is a different order of change
and is not attempted here.

## Consequences

An unset variable behaves exactly as before, which the "no configured verifier
model keeps the active model" test pins. When set, verification is a cross-model
judgment and the snapshot records which model judged.

`verifyGoal` gained a required `model` parameter, so every caller must resolve
one; the existing verifier tests pass their stub model explicitly.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::a configured verifier model judges instead of the active model`
- `plugins/goal/test/lifecycle.test.ts::no configured verifier model keeps the active model`
- `plugins/goal/test/lifecycle.test.ts::an unknown verifier model falls back to the active model`
- `plugins/goal/test/lifecycle.test.ts::a verifier model without auth falls back instead of failing the goal`
- `plugins/goal/test/lifecycle.test.ts::a verifier model spec without a provider prefix is ignored`

Proved: replaced the resolution in `verify` with the active model only. Three
tests failed — the configured-model and default-model assertions, and the
unknown-id fallback (`43 pass, 3 fail`). The auth and prefix tests passed in that
run, so each was probed on its own: removing the auth check failed only the
no-auth test, and accepting a bare id failed only the prefix test.
