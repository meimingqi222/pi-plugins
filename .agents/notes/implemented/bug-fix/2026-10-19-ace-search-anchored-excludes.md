# Agent Note: Anchor ambiguous exclude names in pi-ace-search

Status: implemented

## Problem

`DEFAULT_EXCLUDE_PATTERNS` listed `vendor`, `env`, `target`, `bin` and `obj`
as bare names, and `createExcludeMatcher` applies a bare name to **every path
segment at any depth** (acemcp's rule). For layouts where those are ordinary
source directory names, the walker silently indexed nothing:

```
EXCLUDED  src/env/index.ts       EXCLUDED  src/bin/main.go
EXCLUDED  src/target/handler.rs  EXCLUDED  src/vendor/lib.go
EXCLUDED  packages/a/dist/index.js
```

The tool reported success with an empty index. The any-depth rule is
intentional and tested; the harmful part is applying it to names that are
ambiguous between build output and source.

## Decision

Support a leading `/` in an exclude pattern as a project-root anchor, and use
it for the ambiguous names: `/vendor`, `/env`, `/target`, `/bin`, `/obj`.
`dist` and `build` stay unanchored because they are outputs at every depth.
`node_modules`, `.venv` and the cache directories stay unanchored.

The trade-off is deliberate: a nested .NET `bin`/`obj` build directory may
now be indexed (noise), while `src/env` and `src/target` source trees are no
longer silently dropped. Noise is visible and correctable; missing recall is
not.

## Alternatives considered

**Keep the bare names and document the limitation.** The default configuration
would still index nothing for common Go/Elixir/Rust/Java layouts, and the
failure is silent.

**Anchor every name at the root.** `.git` and `node_modules` can appear in
nested packages and must stay excluded at any depth.

**Detect the project type and choose excludes.** More accurate, but a new
heuristic to maintain and still wrong for polyglot repositories.

## Consequences

Root-level `vendor/`, `env/`, `target/`, `bin/` and `obj/` are still excluded.
Nested source directories with those names are indexed. A user-configured
pattern beginning with `/` now has root-anchored meaning instead of being
treated as a literal path with an empty first segment.

## Verification

- `plugins/ace-search/test/walk.test.ts` — "a leading slash anchors a name to
  the project root" asserts root-level names are excluded, src/env and
  src/bin are not, and an unanchored `dist` still matches at any depth.

Proved: with `plugins/ace-search/src/walk.ts` and `plugins/ace-search/src/config.ts` restored, the new test
fails because a leading-slash pattern is parsed as a path pattern whose first segment is empty,
so nothing matches it.
