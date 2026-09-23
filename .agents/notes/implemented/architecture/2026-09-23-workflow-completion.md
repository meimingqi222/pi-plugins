# Agent Note: pi-workflow completion — dead code removal and documentation

Status: implemented

## Problem

The pi-workflow plugin was fully implemented across the earlier sessions of the
dual refactor (core, host, runner, runs, pi layers; 153 tests), but two things
still contradicted the shipped design.

`runner/hoh.ts` held the HoH Planner→Developer→QA prompt builders and schemas,
even though `iterate()` was a deliberate non-goal. The module was never
exported, never imported, and had no tests: dead code that contradicted the
documented decision and would read to a future maintainer as a half-built
feature.

The documentation was equally behind. `plugins/workflow/README.md` still
described "stage 1 of 5, core only, not loadable", and `ATTRIBUTION.md`'s
divergence table said the isolation seam was "not ported yet" and named a
subprocess as the future host. Both described a plugin that no longer existed.

## Decision

Remove the dead code and bring the documentation in line with what shipped.

- Deleted `runner/hoh.ts` and the `IterateOptions` / `IterateEvidence` /
  `IterateResult` types in `core/types.ts`. If `iterate()` is ever wanted, the
  roles in `runner/roles.ts` are the piece that makes it expressible as
  `agent()` calls in a script.
- Rewrote `plugins/workflow/README.md` to describe the shipped plugin: the
  `workflow` tool and `/workflows` command, background runs with delivered
  results, the worker script host, role→tool isolation, the dual-axis budget,
  and prefix-only journal resume — plus an explicit "deliberately not built"
  list.
- Corrected `ATTRIBUTION.md`: the host is a `node:worker_threads` worker, and the
  tool-isolation and run-lifecycle divergences (role→`--tools` instead of a
  child-side ACL extension; background registry instead of a blocking call) are
  now recorded.
- Updated the root `README.md` plugin table and the `pi-run-core` paragraph.

## Alternatives considered

**Keep `runner/hoh.ts` as dead code.** The cheapest option, but it contradicts
the documented decision, has no test keeping it compiling, and would be
resurrected by a reader who assumed it was wired up.

**Implement `iterate()` as well.** It overlaps `pi-goal`'s verifier, which is the
stronger implementation (isolated model, detached context); a second
Planner→Developer→QA loop would be a competing mechanism rather than a feature.

**Leave the documentation at stage 1 and correct it later.** A README that says
the plugin is not loadable is worse than no README: it is the first thing a
reader trusts and the last thing a test can catch.

## Consequences

The plugin contains no module that is not on an import path, so the package no
longer ships code that contradicts its own non-goals. The README,
`ATTRIBUTION.md`, and the root table describe the shipped plugin, so the
documentation and the code agree. The `iterate()` non-goal is now stated in the
README rather than only implied by an absent file, which is what keeps it from
being re-proposed as unfinished work.

## Verification

- `bun test` — 542 pass, 0 fail, 38 files
- `bun run typecheck` — 6/6 packages clean
