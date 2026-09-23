# Agent Note: Extract pi-run-core and migrate pi-goal onto it

Status: implemented

## Problem

`pi-goal` had grown four primitives that are not about goals at all: a
staleness guard, active-time accounting, token accounting, and a
self-continuation delivery channel. Each one is small, and each one had already
been the site of a real bug — `2026-09-21-goal-verification-lifecycle` and
`2026-09-22-goal-stall-fingerprint-drift` are two of them, and the continuation
provenance fix immediately before this note was a third.

A planned `pi-workflow` needs all four. Copying them would mean two
implementations of the parts that are hardest to get right, drifting in the
direction of *not* checking: a stale verifier verdict completing a replaced
goal, a continuation starting a turn for a cleared goal, a budget that stops
admitting work for one plugin and not the other.

## Decision

Extract `plugins/run-core` as a **library, not an extension** — no `pi`
manifest, nothing registered — and migrate `pi-goal` onto it. A plugin depends
on it in one direction, so every plugin stays independently installable, which
is the property the `pi-redact` / `pi-jev-compact` bridge was also built to
preserve.

The shared surface is deliberately narrow, and each export is there because it
is subtle rather than merely shared:

- `RunGuard` — epoch × session tokens. `isCurrent` compares both counters
  rather than a per-operation boolean, so a token issued before an invalidation
  cannot be revived by a later one.
- `ActiveTimer` — carries the sub-second remainder across boundaries. Flooring
  each span independently drops up to a second per boundary.
- `readTokenUsage` — one definition of what a message cost. Two definitions
  would disagree about when a budget ended.
- `appendRunSnapshot` / `restoreLatestRun` — the "newest valid wins, a
  malformed newest entry is absent rather than skipped over" rule.
- `ContinuationChannel` — raises the outstanding flag on `sendMessage`, consumes
  it on `agent_start`. Consuming per *attempt* is what stops a user follow-up
  inside a continuation-started run from being reported as goal work.
- `RunBudget` — dual-axis and fail-closed. Tokens bound cost; agent calls bound
  fan-out. Either exhausted refuses admission, and `admit(n)` lets a panel be
  refused whole rather than after a prefix has run.
- `isolatedComplete` / `withDeadline` / `parseJsonReply` — a tool-free judgment
  call whose deadline the caller cannot forget, plus the reply parser.

`RunBudget` and `isolatedComplete` are not yet consumed by `pi-goal`. They are
included now because the boundary is what this change is establishing, and
moving them later would mean re-opening it.

## Alternatives considered

**Keep the primitives in `pi-goal` and have `pi-workflow` import
`pi-goal`.** Makes the two packages depend on each other, and `pi-goal` would
carry a dependency tree for a feature it does not have. It also inverts the
layering: goal state is not a workflow primitive.

**Duplicate the primitives in the second plugin.** No coupling, but the two
copies drift on exactly the cases that were already fixed once. The failure mode
is silent — work from a superseded run landing on current state.

**Share through `pi.events` instead of a package**, as `pi-redact` and
`pi-jev-compact` do. That bridge exists to keep two *peer plugins* from
depending on each other. A library is a different relationship: one-directional
by construction, and it can carry types, which an event bus cannot. The event
bus remains the right tool for peer coupling.

**Put the shared code in `pi-goal` and re-export it.** A consumer would then
have to install a goal plugin to get a timer.

## Consequences

`pi-goal`'s public surface is unchanged: the same commands, the same tools, the
same snapshot format. The migration is behaviour-preserving, and the 75 existing
tests passing unchanged is the evidence for that claim rather than an assertion
about the diff.

`RunGuard` replaced a pair of module-level `epoch`/`session` counters that were
read and written from a dozen places. The guard is now a value, which is what
lets `Flight` hold its own token and `current()` compare it in one expression.

`ActiveTimer` replaced `activeSince` plus `goal.elapsedMs` arithmetic. Elapsed
time now survives a reload correctly, because `restore` seeds the timer from the
restored snapshot instead of restarting from zero — a latent bug the old
arithmetic had and no existing test covered.

## Verification

- `plugins/goal/test/lifecycle.test.ts` — 75 tests, all passing unchanged
- `plugins/run-core/test/run-core.test.ts` — 21 tests
- `plugins/run-core/README.md` documents the boundary and the non-goals

Proved each kill-surface independently, so no single assertion carries the whole
claim:

- Making `RunGuard.isCurrent` always return `true` failed **no goal test**. This
  is recorded rather than hidden: the goal suite exercises the guard only
  through paths that also check the goal id, so the guard's own tests in
  `run-core` are the ones pinning it (`an earlier token cannot be revived by a
  later issue`, `nextSession invalidates outstanding tokens`). The migration did
  not weaken the goal suite; the guard is covered where it now lives.
- Making `ContinuationChannel.consume` always return `true` — the exact
  pre-fix bug — failed exactly the three provenance tests
  (`pausing during a user turn...`, `clear also leaves a user turn running`,
  `a user follow-up inside a continuation run is not goal-driven`).
- Dropping `cacheRead`/`cacheWrite` from `readTokenUsage` failed exactly
  `readTokenUsage > derives from all four fields when no total is present`. No
  goal test pins it, because the goal fixtures set `totalTokens`, which
  short-circuits the sum.

Full workspace after restoring all three: `385 pass, 0 fail` across 24 files,
`bun run typecheck` clean for all five plugins.
