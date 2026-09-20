# Agent Note: Censor the captured group, not its first textual occurrence

Status: implemented

## Problem

`applyPatterns` in `src/engine.ts` rewrote each match by replacing the captured
text with `String.replace`:

```ts
const captured = typeof rest[0] === "string" ? rest[0] : full
return full.replace(captured, censor)
```

`String.replace` replaces the **first textual occurrence** of `captured` inside
`full`, which is not necessarily where capture group 1 matched. When the secret
text also appears in the match's leading context — a keyword echo, a repeated
value, a quote-adjacent duplicate — the wrong span was rewritten. Two failures
follow from that one line:

- **Corrupted output.** The context occurrence is censored, mangling the
  surrounding text instead of the credential.
- **Leaked credential.** The actual capture group is left in cleartext. The
  pattern matched, `hits` incremented, and the secret was sent to the model
  anyway — the worst shape for a security gate, because the counter reports
  success while the secret leaves the machine.

This was found while auditing the engine, not from a field report; no built-in
pattern is known to trigger it, but `extraPatterns` in `redact.json` and any
future pattern with a repeated leading context can.

## Decision

Patterns are compiled with the `d` (hasIndices) flag, and a dedicated
`censorMatches` helper rewrites each match using the offsets in
`match.indices[1]`:

- emit input before the match,
- emit the match with group 1's span replaced by the censor,
- emit the rest of the match verbatim,
- advance past the match.

Group 1 is the secret by convention; the remainder of the match is context and
is preserved. When group 1 is absent, empty, or spans the whole match, the
entire match is censored, so whole-match patterns keep working. The helper also
replaces the previous `lastIndex = 0` plus `replace` dance with a single `exec`
walk.

## Alternatives considered

**Recover the capture offset without `d`.** Reconstructing group positions by
re-running a sub-pattern is fragile for alternation, lookarounds, and nested
groups — it would need its own mini regex engine and would be wrong in exactly
the cases this bug is about.

**Anchor every pattern with `^`/`$` or boundaries.** Pushes the problem into
112 hand-written patterns and still cannot express "group 1 is the secret" when
the leading context is variable-length.

**Censor the whole match.** Correct and simplest, but it deletes the keyword
context (`KEY="` … `"`), making the redacted payload harder for the model to
interpret. Rejected as a behavior regression rather than a bug fix.

## Consequences

Patterns must keep the secret in group 1 and provide no capture group *before*
it, because only group 1 is censored. That is already the convention across
`src/patterns.ts`, and `censorMatches` documents it at the call site.

Patterns with nested groups inside group 1 are safe: `mailgun-token` uses
`((pub)?key-[a-f0-9]{32})`, where group 2 is inside group 1, and group 1 still
spans the whole credential.

`d` is supported by Node 16+, Bun, and current browser engines, so it costs
nothing at runtime. The helper is a single pass and no longer allocates a
throwaway `replace` callback per match.

## Verification

Tests in `plugins/redact/test/engine.regression.test.ts` cover the three shapes: context
repeats the secret, context is preserved, and group 1 spans the whole match.

- `plugins/redact/test/engine.regression.test.ts::only the capture group is censored, keyword context survives`
- `plugins/redact/test/engine.regression.test.ts::a secret repeated in the prefix is censored at its own offsets`
- `plugins/redact/test/engine.regression.test.ts::an empty or whole-match capture group censors the entire match`

Proved: restored `full.replace(captured, censor)` in place of the group-offset
rewrite → `a secret repeated in the prefix is censored at its own offsets`
failed (the context occurrence was censored while the real capture survived),
then reverted and re-ran green.
