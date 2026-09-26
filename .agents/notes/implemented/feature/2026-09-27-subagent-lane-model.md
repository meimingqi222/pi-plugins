# Agent Note: A foreground call is a lane too (P1)

Status: implemented

## Problem

`BackgroundRecord`/`BackgroundRegistry` modelled only detached tasks. A
foreground `subagent` call — the default path — was invisible to the registry,
so the fleet widget could show an idle session while the model was blocked
inside a delegation: the same blind spot the fleet work was built to close,
one layer up. The type name also hard-coded "background" into an entity that
the P2 reply transport needs to treat uniformly (queued prompts, generation
guard, a state machine spanning spawn to settle).

## Decision

`src/lane.ts` owns the entity: `Lane = BackgroundRecord + kind + queuedPrompts
+ generation`, and `LaneRegistry` (renamed registry) with `launch` now
returning `{ record, done }` — `done` resolves at settle, which is what makes
a foreground lane awaitable without a second code path. `background.ts`
shrinks to a compatibility shim: type aliases (`BackgroundRecord = Lane`,
`BackgroundRegistry = LaneRegistry`, `deriveAlias` re-export) plus the display
functions that were always about rendering, not owning (`deriveChildState`,
`formatBackground`, `formatDuration`).

Three behavioural rules make a foreground call a lane rather than a task:

- **Registered, not addressable.** Foreground calls launch with
  `kind: "foreground"`: they appear in `list()` (widget, panel, `/subagents`)
  but `stop()` refuses them (`kind !== "background"` → false) — no id ever
  reaches the model, so nothing should be able to cancel one by id. Internal
  teardown (`stopAll`, the tool call's own abort signal via the new
  `abort(id)`) bypasses the kind gate by design.
- **No slot.** `atCapacity` counts only `kind: "background"` lanes — a
  foreground call never occupies one of the four background slots.
- **Session-less contexts keep the direct path.** A lane is session-scoped
  by definition; a `ctx` without `sessionManager` (embedded hosts, tests)
  falls back to plain `executeSubagent` rather than registering an orphaned
  lane — this is what kept the two pre-lane foreground tests green.

`queuedPrompts` and `generation` are stored now so P2 is transport-only:
queued prompts buffer replies for a live child, generation discards stale
callbacks. The foreground path also forwards `onProgress` into the registry,
so a blocking call's live tool activity shows in the panel the same way a
background child's does.

## Alternatives considered

- **Keep two registries** (foreground shadowed, background owned). Rejected:
  the fleet would need two truth sources for "is anything running" — exactly
  the drift the shared surface exists to prevent.
- **Make `stop()` abort foreground lanes too.** Rejected: an unreachable-by-id
  entity that can still be killed by id is a contract leak; the tool call's
  own signal is the right abort channel.
- **`launch` returning just the record.** The foreground path needs to await
  settle; a second `runForeground` entry point would duplicate the work
  wrapper. `{ record, done }` covers both with one shape.

## Consequences

A blocking delegation now paints a row in the widget and a line in
`/subagents`; the panel's cancel hint correctly refuses foreground lanes.
`stopAll` on session teardown aborts foreground lanes too — previously a
session switch left a blocking child orphaned until its own timeout. The
`launch` signature change (`options` bag, `{record, done}` return) is the
only breaking change and all call sites updated.

## Verification

- `plugins/subagent/test/lane.test.ts` — foreground lanes list but never
  occupy a background slot; `stop` refuses them while `abort()` reaches them;
  `stop` still cancels background lanes; alias fallback and generation are
  carried; `deriveAlias` splits the first line before stripping control
  characters.
- `plugins/subagent/test/plugin.test.ts` — the two foreground tests pass
  unchanged through the session-less fallback path.
- Proved: the abort-race in the test helper (an already-aborted signal
  dispatches no later event) timed out two tests until `work` mirrored the
  real executor's synchronous `signal.aborted` check — the registry's abort
  semantics are pinned by the same tests.

90 tests pass, `bun run typecheck` clean.
