# Agent Note: Remove parameter properties so extensions load under Node

Status: implemented

## Problem

`pi-run-core`'s shared classes used TypeScript **parameter properties**:

```ts
constructor(private readonly now: () => number = Date.now) { ... }
```

pi loads extensions through `jiti`, which transpiles them, so this worked in
every interactive run. It failed under **plain Node**, whose strip-only
TypeScript support rejects parameter properties outright:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
    at .../plugins/run-core/src/usage.ts:47
```

pi's own entry point is `#!/usr/bin/env node`, and `pi-goal` ships a test that
runs a real Node child for exactly this reason — it was added when `Bun.file`
turned out to throw `ReferenceError` under Node and `readPlan`'s own catch
silently converted that into "no plan". The same class of bug, in a new place,
caught by the same test.

The consequence was not cosmetic. `ActiveTimer` is imported by `pi-goal`'s
entry, so the whole extension would fail to load under Node while continuing to
work in a `bun test` suite that cannot observe the difference.

## Decision

Replace every parameter property with a plain field and an explicit assignment,
in the modules a plugin loads, and say why in the code:

```ts
private readonly now: () => number;

constructor(accumulatedMs = 0, now: () => number = Date.now) {
  this.now = now;
  ...
}
```

Applied to `run-core/usage.ts` (`ActiveTimer`), `run-core/deliver.ts`
(`ContinuationChannel`), and `workflow/runs/orchestrator.ts` (`Semaphore`).

## Alternatives considered

**Rely on jiti and ignore Node.** That is what the code did, and it is wrong:
the failing entry point is pi's own shebang, so "works under jiti" does not imply
"works when a user runs pi".

**Add a build step that down-levels parameter properties.** Correct but adds a
build to a package whose whole appeal is being loadable from source. The
construct buys nothing here — it saves one line per class.

**Change the test to stop spawning Node.** That would delete the only check for a
real deployment path.

**Fix only `run-core` and leave `redact`.** `redact`'s `LruStringCache` has the
same construct, and it is harmless only because that class is not on the entry's
import path. Left alone deliberately, and recorded here: it is a latent instance,
not a fixed one.

## Consequences

Every module a plugin loads is now plain enough for Node's strip-only TypeScript
mode. The style constraint is mildly unusual for TypeScript code, so each site
carries a comment naming the reason rather than leaving a future reader to
"tidy" it back.

`plugins/redact/src/engine.ts` still uses the construct. It is not currently
reachable from an entry point; if it becomes reachable, the same fix applies.

## Verification

- `plugins/goal/test/plan.test.ts` — the Node child test that caught it: it
  spawns `node` and imports the module, so a strip-only incompatibility fails
  the test rather than a user's session.
- `plugins/run-core/test/run-core.test.ts` — `ActiveTimer` and
  `ContinuationChannel` behaviour, unchanged after the rewrite.
- `plugins/workflow/test/orchestrator.test.ts` — the concurrency bound the
  rewritten `Semaphore` still enforces.

Proved: running the goal suite before and after: `74 pass, 1 fail` with the
parameter property present (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX from the Node
child), `75 pass, 0 fail` after. The failing test is the one written for this
bug class, so the fix and the guard agree.

Full workspace after the fix: `501 pass, 0 fail` across 34 files, `bun run
typecheck` clean for all six packages.
