# Agent Note: pi-permissions feeds the reviewer the whole command

Status: implemented

## Problem

In `auto`, a grey bash call is sent to the reviewer model, but the payload's
`toolInput` was built with `summarizeInput(...)` — the 240-char summary the
approval dialog shows. `reviewer.ts` bounds its own payload at 4000 chars, so
the smaller display limit always won first. Long commands therefore reached
the reviewer cut mid-token: a real incident command (271 chars, chaining
`cat ~/Library/Caches/…`, `find … | head`, `go tool objdump … | head -5`)
arrived as `…~/.local/share/trae-cli/trae-cli…` — the quoting, the pipes and
the terminator gone. The reviewer answered `ask (p=0.46)`: an unterminated
command reads as unparseable, which its rubric maps to "unsure → ask". The
reviewer was judging a mutilated call, and every long command paid a spurious
human prompt.

## Decision

`prompt.ts` splits the two concerns: `flattenInput` strips control characters
and flattens newlines with no bound, and `summarizeInput` applies the 240-char
display cap on top of it. `index.ts` passes `flattenInput(...)` to the
reviewer; `reviewer.ts` keeps its 4000-char payload bound (applied to both
backend paths) as the single network-payload limit. The approval dialog is
unchanged.

## Alternatives considered

**Raise the 240-char cap everywhere.** The cap exists because the title renders
in a terminal; 4000 characters of command in a `select` dialog is worse than
the truncation it fixes.

**Pass the raw input to the reviewer.** Newlines and control characters add
nothing to the judgment, and the reviewer module would lose its payload bound.
Flattening was already the right shape — only the wrong bound.

## Consequences

The reviewer sees whole commands up to 4000 chars; the display is unchanged.
The reviewer's per-call memoization key also becomes the full flattened input,
so two commands sharing a >240-char prefix no longer share a verdict — finer
caching, never a wrong one.

## Verification

- `plugins/permissions/test/plugin.test.ts` — "auto: reviewer sees the command
  past the 240-char display summary": a grey command carrying a marker beyond
  char 240 must arrive whole in the registry-reviewer payload, while the
  approval dialog still shows the bounded `…` summary.

Proved: with `plugins/permissions/src/index.ts` reverted (`toolInput` built
with `summarizeInput`), the test fails — `19 pass, 1 fail`, the payload stops
at the display cap. With the fix, `bun test plugins/permissions/test/plugin.test.ts`
reports 20 pass, 0 fail.
