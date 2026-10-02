# Agent Note: Launch subagent children on the physical model, not a virtual selection

Status: implemented

## Problem

`pi-subagent` built the child's model by joining the session provider and model
id with a slash at three launch sites and passed it to the child pi process as
`--model`. Since pi 1.0 `ctx.model` is the session *selection*, which can be a
virtual model: a catalog entry an extension registered, with no provider
credentials of its own.

A child pi resolves `--model` against its own catalog, so a virtual id resolves
only when the extension that registered it is loaded in the child too. That
depends on where the user installed it — globally, project-locally, or not at
all — and nothing in the parent process can see it. The child either fails to
start or silently runs a model the user did not select.

The same shape exists wherever `ctx.model` crosses a process boundary, so the
bug is not specific to this plugin.

## Decision

`pi-run-core`'s `childModelSpec(ctx, { policy })` resolves what to hand a child,
defaulting to `policy: "physical"`:

- the physical model that answered the newest assistant message, when the
  registry still has it and it still has credentials;
- otherwise the session selection, with a `reason` reporting that the child
  inherits an id it can resolve only if the same extensions are loaded there;
- a context with no session model at all yields no spec and no warning — the
  pre-existing behaviour, which passed no `--model` and stayed silent.

`policy: "selection"` opts into passing the virtual selection for a user who has
the router installed where children load it too and wants them routed.

`pi-subagent` resolves once per launch through `childModelFor(ctx)`, which warns
at most once per distinct reason.

## Alternatives considered

**Pass the selection and let the child figure it out.** The child cannot: a
virtual id is only meaningful inside the process that registered it.

**Probe the child for the model before spawning.** Doubles the startup cost of
every delegation to detect a condition the parent can answer itself.

**Inherit the router so children get routed too.** A router's state lives on the
parent's session branch, so a child re-derives routing from scratch and re-runs
any classifier. Routing a child is a decision for the user to opt into, not a
side effect of where an extension is installed.

## Consequences

A child launched before the first response still inherits the selection, and now
says so once. Children no longer silently depend on where the user installed a
router extension. `pi-agent-runner` needed no change: it already forwards
`--model` verbatim, and the model it is handed is now the right identity.

### Probed against `@earendil-works/pi-coding-agent@1.0.0`

Read from the published 1.0.0 `dist` and confirmed by running its CLI offline
(`--offline --no-extensions`) against a probe extension that registers
`probe/auto` and whose `route()` throws a unique marker. Two facts support the
physical-first default:

- `resolveModel()` throws `Virtual model p/i is not registered.` when the model
  is not in that process's `virtualModels` map. Registration lives in the
  process that loaded the extension, so a child that did not load the router
  extension cannot resolve a virtual id at all — there is nothing to fall back
  to, only an error.
- `resolveModel()` refuses a virtual target, because `getPhysicalModel()` filters
  virtual entries out. A child therefore can never re-delegate a virtual
  selection to another virtual model, which is why `policy: "selection"` is an
  explicit opt-in rather than something inherited by default.

**P3, measured.** `pi --model probe/auto --print hi`:

- extension **not** loaded (the subagent case): fails at startup with
  `Error: Model "probe/auto" not found. Use --list-models to see available
  models.` and a `Hint: Start without extensions using "pi -ne".`, exit 1.
- extension **loaded** (cwd `-e` plus `jiti` resolvable): passes resolution,
  reaches routing, and the probe marker fires — exit 1.

So the two cases are distinguished by exactly one thing, whether the router
extension is loaded in the child, and the failure is a hard exit rather than a
silent fallback. That is the measured case for the physical-first default: a
parent cannot detect which of the two a child will be, and a virtual id that
resolves in the parent may not resolve in the child.

## Verification

- `plugins/subagent/test/plugin.test.ts::the fleet surfaces > a child is launched on the physical model, not a virtual selection`
- `plugins/run-core/test/model-identity.test.ts`

Proved: reverted `childModelFor` to the old inline template that joined the
session provider and model id with a slash;
`a child is launched on the physical model, not a virtual selection` failed with
`expected "openai-codex/gpt-5.6-luna", received "jev/auto"`, then passed once the
physical-first resolution was restored.
