# Agent Note: Bound workflow fan-out to what a provider tolerates

Status: implemented

## Problem

The default live-agent cap was 8. That is a number nobody chose: a fan-out is only
as reliable as the provider behind it, and many reject a burst of concurrent
sessions. The failure is not queuing — a refused call is a **failed agent**, and a
failed agent inside a barrier becomes `null`, so a run degrades silently while its
cost stays real.

There was also no way to express the provider's tolerance once. `maxConcurrency`
existed, but a script that asks for 16 concurrent agents gets 16, and the model
writing the script has no reason not to.

## Decision

**A provider ceiling, defaulting to 4, that a request can only lower.**

- `maxConcurrencyCeiling()` reads `PI_WORKFLOW_MAX_CONCURRENCY`, defaulting to
  `DEFAULT_MAX_CONCURRENCY = 4`, clamped to `1..32`. A malformed or out-of-range
  value falls back to the default rather than disabling the bound — a typo in the
  variable must not become an unbounded fan-out.
- `resolveMaxConcurrency(requested)` clamps the request to that ceiling. A script
  asking for more than the provider tolerates is **clamped, not refused**: a
  clamped run still makes progress, a refused one makes none.
- The tool's schema maximum is 32 again (not 4), because the ceiling is
  configurable and a schema cap of 4 would make the override unreachable through
  the parameter. The description and the guideline both state the default and the
  clamp, so the model knows a high request is advisory.
- README documents the ceiling as the place to set it once, next to the tool
  surface.

## Alternatives considered

**A hard-coded cap of 4** (the shape this first arrived in, as `maximum: 4` and a
`Math.min(4, …)` clamp). It has the right default and the right failure mode, but
it makes the environment and the parameter dead weight: a provider that tolerates
16 has no way to say so without editing the plugin, and the schema's `maximum: 4`
hides that a `maxConcurrency` of 8 was silently clamped.

**Raise the default instead of capping the request.** It helps the model, but the
model is the wrong place for the policy: the provider's tolerance is a property of
the environment, not of the task.

**Count in-flight failures and back off.** Real rate-limit adaptation, but it
turns a bounded fan-out into an unbounded one with a recovery loop, and the
ceiling already prevents the condition it would treat.

## Consequences

A run defaults to 4 live agents, so a provider that tolerates only a small burst
is no longer hit with 8. Raising it is one environment variable, without a code
change or a per-script parameter; a script that asks for more than the ceiling
gets the ceiling, and every agent it did launch still runs.

The clamp means `maxConcurrency` is now a *request* rather than a guarantee, so
the parameter's description and the guideline say so explicitly. A ceiling higher
than the schema's 32 is unreachable, which matches the documented cap.

## Verification

- `plugins/workflow/test/orchestrator.test.ts` — the default is 4; the env
  override is honoured and clamped to 32; a malformed or zero value falls back to
  the default; a panel with no request peaks at ≤ 4; a request above the ceiling
  is clamped rather than refused, and every task still runs

`216 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: two red runs.

- **`resolveMaxConcurrency` no longer clamping to the ceiling.** It failed
  `provider concurrency ceiling > a request above the ceiling is clamped, not
  refused` with `Expected: <= 2, Received: 6` — eight requested, two tolerated.
- **The env override ignored.** It failed `defaults to four and clamps the
  request to it` with `Expected: 9, Received: 4`, so the escape hatch is pinned
  rather than assumed.
