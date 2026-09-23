# Agent Note: Read the goal plan with `node:fs/promises`, not `Bun.file`

Status: implemented

## Problem

`readPlan` read the plan file with `Bun.file(path).text()`. pi loads extensions
under Node — the published CLI starts with `#!/usr/bin/env node`, and the
bundled `dist/bundle/cli.js` contains no `Bun` reference at all. In that runtime
`Bun` is not a global, so the expression threw `ReferenceError` before it could
read anything.

The failure was invisible because it was caught by the function's own guard:

```ts
try { body = await Bun.file(path).text(); }
catch { return undefined; }   // swallows ReferenceError too
```

`readPlan` is documented to return `undefined` for a missing, unreadable or
structurally empty plan. A `ReferenceError` is none of those, but it landed in
the same catch, so "the runtime cannot read files" became indistinguishable from
"there is no plan". Every consumer saw the second.

The consequences all follow from that one collapsed distinction:

- `goal.planStep` was permanently `undefined`, so the continuation never handed
  the model the next unchecked checklist item. The session's own transcript
  shows a goal whose on-disk plan had six unchecked boxes while the continuation
  told the model "Its ## Task checklist has no unchecked item."
- `planProgress` was always `{ done: 0, total: 0 }` and `criteriaEdited` was
  always `false`, because both derive from the same unreadable parse.
- The verifier's `planStep` / `planProgress` evidence was therefore vacuous on
  every round, while `criteria` still arrived — it is held in the goal snapshot
  from the planner's in-memory result rather than re-read from disk.

The test suite could not see it. `bun test` defines a `Bun` global, so the same
code path succeeded there. The existing `readPlan` cases only asserted that
unusable input yields `undefined`, which the `ReferenceError` satisfied for the
wrong reason.

## Decision

`readPlan` reads through `readFile` from `node:fs/promises`. Node is the runtime
that actually loads the extension, and `node:` builtins are already the norm
across these plugins, so this removes a runtime assumption rather than adding
one. The catch keeps its meaning: a genuinely missing or unreadable file is
still `undefined`.

The regression test runs the real read in a Node child process. `bun test`
exposes `Bun` as a **non-configurable, non-writable** global, so a test cannot
delete or shadow it in-process — the earlier attempt failed with `Attempted to
assign to readonly property` and `Attempting to change configurable attribute of
unconfigurable property`. Spawning Node is the only faithful way to observe the
absence of the global, which is precisely the condition that broke.

## Alternatives considered

**Keep `Bun.file` and guard with `typeof Bun !== "undefined"`.** Preserves the
Bun path for Bun-hosted runs, but no such run exists, and it leaves two file-read
implementations to keep in sync for no benefit.

**Make the catch rethrow anything that is not `ENOENT`.** A correct hardening in
its own right, but it would have turned the `ReferenceError` into a crash rather
than fixing the read. Rejected as a fix; noted as a separate idea.

**Assert `readPlan` succeeds in-process and trust that it covers Node.** This is
exactly the assumption that hid the bug — the test would pass under `Bun.file`
too, which is why it cannot pin the regression.

**Skip the child process and unit-test a thin `readTextFile` seam.** Introducing
an indirection purely so a mock can replace it tests the mock, and the point of
the failure is the real runtime, not the call shape.

## Consequences

`goal.planStep` populates from disk on every work run, so the continuation hands
the model the first unchecked checklist item and `criteriaEdited` can finally
become true when an implementer rewrites the criteria section. The three
call-site behaviors that were dead on Node resume working.

The test is slower than the others because it spawns a process, and it requires
a `node` on `PATH` (`PI_GOAL_TEST_NODE` overrides the binary). Both are accepted:
the alternative is a test that cannot fail when the bug is present.

## Verification

- `plugins/goal/test/plan.test.ts` — including the Node child test
  "readPlan works under Node, where pi loads extensions and Bun does not exist"

Proved: restored `Bun.file(path).text()` in `readPlan`. The Node child returned
`{"plan":null,...}` while the test expects the parsed plan, so the suite went
red with one failing assertion (`9 pass, 1 fail`). Restoring `readFile` from
node:fs/promises returned it to green (`10 pass, 0 fail`).
