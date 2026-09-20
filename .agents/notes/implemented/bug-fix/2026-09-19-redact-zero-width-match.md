# Agent Note: An empty-matching rule must terminate and stay inert

Status: implemented

## Problem

Two independent assumptions in `src/engine.ts` broke on a pattern that can match
the empty string, and they compounded:

1. The regex-compile fallback was `/^$/`. When a rule failed to compile,
   `compilePatterns` logged a warning and substituted a pattern that **matches
   every empty string** instead of a pattern that matches nothing.
2. The replacement loop in `applyPatterns` used `String.replace`, which does
   not advance past a zero-width match. A rule that matches empty at a fixed
   offset re-matches at the same offset forever.

The result was a hang rather than an error: `redactString` never returned, the
provider call never completed, and the session stalled with no diagnostic. A
rule that matches empty is reachable from user-supplied `extraPatterns` in
`redact.json`, from any pattern edit that introduces an optional group where
the whole pattern can be satisfied by nothing, and from the compile-error path
itself.

## Decision

The compile-error fallback is `/(?!)/g`, a pattern that can never match, so a
broken rule is skipped rather than applied indiscriminately.

`censorMatches` (the rewrite loop) skips zero-width matches and forces
`lastIndex` past them:

```ts
if (match[0] === "") {
  if (regex.lastIndex <= match.index) regex.lastIndex = match.index + 1
  continue
}
```

The guard is defensive on the `lastIndex` advance because some engines leave
`lastIndex` unchanged on a zero-width match; without that clause the loop would
still spin even with the skip.

## Alternatives considered

**Keep `/^$/` and rely on the zero-width guard alone.** The guard stops the
hang, but a broken rule would still match and rewrite empty strings, which
means a typo in a config pattern silently mangles payloads. Failing inert is
the correct behavior for a rule that could not be understood.

**Reject empty-matching patterns at compile time.** Detecting "can this regex
match empty" in general requires running the regex, which is what the guard
already does cheaply per match. A static check would either be incomplete or
reimplement a regex engine.

**Throw on a zero-width match.** Turns a stall into an error, but the handler's
fallback is to send the original payload, so throwing would leak rather than
redact. Skipping the empty match is both safe and correct — an empty match has
nothing to censor.

## Consequences

A misconfigured or uncompilable pattern is silently inert rather than loudly
broken. The warning is logged via `setLogger`, so `redact.json` authors can
still see it, but it will not surface in the TUI by default. This is the
deliberate trade: a security gate should fail closed (send nothing extra to the
model, redact what it can) rather than fail open.

## Verification

`plugins/redact/test/engine.regression.test.ts` pins the terminating behavior with a rule that
can match empty (`(x?)`), which is the shape both bugs converge on.

- `plugins/redact/test/engine.regression.test.ts::a rule that can match the empty string terminates and is inert`

Proved: removed the zero-width guard from `censorMatches` so the loop used the
original `String.replace` behavior → the test above hung and failed with
`this test timed out after 5000ms`, then reverted and re-ran green.
