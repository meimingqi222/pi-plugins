# Agent Note: An unrooted path pattern in EXCLUDE_PATTERNS matched nothing

Status: implemented

## Problem

`createExcludeMatcher` split configured exclude patterns into three buckets:
bare names, wildcard names, and anything containing `/`. The path bucket was
matched as an unanchored prefix:

```ts
for (const pattern of paths) {
  if (relativePath === pattern || relativePath.startsWith(`${pattern}/`)) return true;
}
```

Two independent defects came out of that loop.

**Unanchored matching is unsafe.** A configured `packages/desktop/dist-*` was
matched with a plain `startsWith`, so a nested `vendor/packages/desktop/dist-x`
would also be excluded. `.gitignore`-style semantics anchor a pattern that
contains a separator at the project root, and the walker feeds
project-root-relative paths, so anchoring is both correct and cheap.

**A wildcard in a path pattern matched nothing at all.** The first fix attempt
replaced the prefix check with a segment-wise matcher that consumed the whole
path. A pattern ending in a wildcard segment (`packages/desktop/dist-*`) then
required the path to be *exactly* as long as the pattern, so the directory
`packages/desktop/dist-main` — the very thing the pattern exists to prune — did
not match, and the walker descended into build output.

The failure was silent: a few extra files indexed, no error, and the exclusion
only visibly mattered as a slower hash pass.

## Decision

`matchPathPattern` matches segment by segment with two documented rules:

- `*` within a segment does not cross `/`, so a two-segment wildcard pattern does
  not match a three-segment path;
- matching a **prefix** of the path is a match. The walker prunes directories, so
  a pattern that matches a directory stops the whole subtree from being visited;
  requiring full consumption made a trailing wildcard useless.

`**` is supported for completeness (last-segment `**` matches the rest), though
none of `acemcp`'s configured patterns use it.

The `basename` variable and the `isDirectory` parameter's role in the name check
were also dropped: with the segment check applied uniformly, a trailing
directory flag adds nothing.

## Alternatives considered

**Use a real `.gitignore` matcher (`ignore`, already a pi dependency).**
Attractive, but `EXCLUDE_PATTERNS` is not a `.gitignore` file — it has no
negation, no directory-only syntax and no per-directory precedence. Importing
the full spec would make behaviour diverge from `acemcp`, which is the one thing
this matcher must not do, because a divergence changes which files are indexed
and therefore which hashes are valid.

**Anchor strictly and require full consumption.** Correct for the anchored case,
broken for every pattern ending in a wildcard section, as above.

## Consequences

- Path patterns are anchored at the project root and may match a directory
  prefix, so build-output directories are pruned as intended.
- Behaviour for bare names and simple wildcards is unchanged, and still mirrors
  `acemcp`'s `Contains('/' + pattern + '/')` rule for bare names.
- The matcher remains a documented subset of `.gitignore`, so a future pattern
  using negation would be silently treated as a literal name. That is acceptable
  because no such pattern exists in the configuration this reads; it is noted
  here so the next reader does not discover it by surprise.

## Verification

- `plugins/ace-search/test/walk.test.ts` — "a bare name excludes that directory
  at any depth", "a wildcard pattern matches by suffix", "a path pattern only
  matches at the root" (asserts both that the root-level directory is excluded
  **and** that a nested look-alike is not).

Proved: restored `return pathIndex === pathParts.length` in
`matchPathPattern` → "a path pattern only matches at the root" failed.
Reverted; 11 tests passed.
