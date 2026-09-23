# Agent Note: Import the JSON Schema checker from `typebox/value`, not `typebox/schema`

Status: implemented

## Problem

`pi-workflow` could not load under pi at all. It installed and `pi list` showed
it, but every load failed:

```
Failed to load extension: Cannot find module '<…>/typebox/build/index.mjs/schema'
Require stack:
- …\plugins\workflow\src\core\schema.ts
```

pi loads extensions through `jiti` and hands it an alias table built by
`getAliases()` in `dist/core/extensions/loader.js`. That table maps `typebox` to
the resolved entry **file** (`…/typebox/build/index.mjs`) and registers only
`typebox/compile` and `typebox/value` as subpaths. jiti's aliases are prefix
replacements, so the extension's `import { Check, Errors } from "typebox/schema"`
became `<entry>/schema` — a path that cannot exist. The same table is in 0.85.1
and 0.87.1, so this is not a version regression.

The table is only used on the path an installed pi takes. pi's loader picks its
resolution options in three ways: bundled/embedded builds use virtual modules,
pi running from its own TypeScript source uses `tsconfigPaths`, and the
unbundled Node build — the `dist` code every npm install of pi runs — uses
`{ alias: getAliases() }`. So the failure was invisible to anyone developing pi
from source, and guaranteed for users.

The repository's guard did not catch it either. `bun test` resolves
`typebox/schema` through the package's `exports` map, which does expose it, so
the in-process `DefaultResourceLoader` test passed while the extension was
unloadable for every real user. This is a third variant of the same class as
`2026-09-22-goal-plan-unreadable-under-node` (a global that exists only under
Bun) and `2026-09-23-parameter-properties-under-node` (syntax only jiti accepts):
the test runtime and the deployment runtime disagree, and only the deployment
runtime is exercised by a user.

Consequences: the extension registered nothing — no `/workflows` command, no
`workflow` or `workflow_status` tools — while looking correctly installed.

## Decision

Import the two functions from `typebox/value`, a subpath pi does alias, and
retype them for plain JSON Schema:

```ts
const checkJsonSchema = Check as unknown as (schema: unknown, value: unknown) => boolean;
const jsonSchemaErrors = Errors as unknown as (
  schema: unknown,
  value: unknown,
) => ReadonlyArray<{ instancePath?: string; message: string }>;
```

Two details differ from the old entry point and are handled at the call site.
`typebox/value` types its checkers against TypeBox `TSchema` objects, which is
why the casts exist rather than an inference. And its `Errors` returns the error
array directly, where `typebox/schema` returned `[boolean, errors]` — so the
destructuring `const [, errors] = Errors(...)` had to go. The error objects
themselves (`keyword`, `schemaPath`, `instancePath`, `params`, `message`) are
the same shape, and the whole call remains inside the existing `try`, so a
malformed schema is still a reported validation failure rather than a throw.

The regression test drives the real `DefaultResourceLoader` in a **Node child**
process, which is what makes the alias table apply, and asserts zero load errors
plus the registered command and tool names.

## Alternatives considered

**Add `typebox/schema` to pi's alias table.** That fixes it for future pi
versions only, requires a release of pi before this extension works, and there
is no user-facing way to extend the table from an extension. The extension
should load on the pi versions users already have.

**Keep `typebox/schema` for values behind a type-only import.** Type-only
imports are erased, so `import type` from `typebox/schema` is harmless — but
nothing here needed a type from it; `WorkflowJsonSchema` is local.

**Route validation through `typebox/compile`.** It is aliased, but its
`Compile` is typed against `TSchema` as well, so it needs the same retyping and
adds a compilation cache this module does not want.

**Vendor a JSON Schema subset validator.** Replaces a maintained checker with
ours; both typebox entry points share its internals, so the swap above keeps the
semantics while the rewrite would have to re-earn them.

**Assert only that loading does not throw.** Passes while the extension
registers nothing, which is the bug.

## Consequences

`plugins/workflow` loads under pi 0.85.1 (the repository's devDependency) and
under the installed global 0.87.1, registering `/workflows`, `workflow` and
`workflow_status` with zero loader errors.

The new test spawns a process, so it costs about 1.8s and needs a `node` on
`PATH` (`PI_WORKFLOW_TEST_NODE` overrides the binary) — the same trade
`pi-goal`'s Node child test already makes. The two casts state a typing
intention the import cannot express; if typebox later exposes a
JSON-Schema-typed subpath that pi aliases, they can be deleted.

Running the gates also surfaced four failures this change did not cause. They
were pre-existing Windows defects in `pi-workflow`: two test files reported all
their assertions as passing and then never exited, one path expectation assumed
POSIX, and the `stop` wiring test timed out. Reverting only the `schema.ts`
import reproduces all four, so they are not this change's. They are fixed in
`2026-09-23-workflow-terminate-once.md`.

## Verification

- `plugins/workflow/test/loader.test.ts` — the new test "pi loads the entry
  point under Node, where the typebox aliases decide which subpaths resolve": it
  spawns `node`, imports pi's own `DefaultResourceLoader`, loads the real entry
  point and asserts `errors: []` with `tools: ["workflow", "workflow_status"]`.
- `plugins/workflow/test/schema.test.ts` — unchanged behaviour of the checker
  after the swap: required and `additionalProperties`, `items`, `enum`, `const`
  and numeric bounds, `anyOf`/`oneOf`, a malformed schema reported rather than
  thrown, and the `safeParse` path.

Proved: `bun test plugins/workflow/test/loader.test.ts` before the change ran
`1 pass, 1 fail`. The Node child reported

```
errors: ["Failed to load extension: Cannot find module '<…>/typebox/build/index.mjs/schema'
Require stack:
- …\plugins\workflow\src\core\schema.ts"]
tools: []
```

which is the user-visible failure reproduced in the suite, while the in-process
test above it stayed green. After the change, both files run `12 pass, 0 fail`.

Confirmed outside the suite as well: the same loader driving
`plugins/workflow/src/index.ts` against the installed global pi reports
`errors: []`, `commands: ["workflows"]`, `tools: ["workflow", "workflow_status"]`.

`bun run typecheck`, `bun run notes` and the workspace-wide `bun run test`
gate are all clean (7 packages, 0 fail). The four Windows failures that the
Consequences section attributes to pre-existing defects are fixed in
`2026-09-23-workflow-terminate-once.md`, which is what let the gate run to
completion on this machine.
