# Agent Note: Workflow scripts run in a vm context so dynamic import() cannot reach node:

Status: implemented

## Problem

The script host compiled the user script with `new AsyncFunction(body)` in the
worker's own realm. The determinism guards stubbed globals on that realm, but
`AsyncFunction` bodies can `await import("node:fs")`, `import("node:os")`,
`import("node:perf_hooks")` — bypassing every guard, while
`WORKFLOW_DESCRIPTION` claimed scripts run with "no network, and no
filesystem". Verified on both Node 22 and Bun 1.4: the dynamic import
succeeded.

## Decision

**Compile and run the script inside a `node:vm` context created in the
worker.**

- `renderWorkerSource()` emits a worker that builds `vm.createContext({})`,
  installs the determinism guards on *that* global
  (`vm.runInContext("(" + installGuards.toString() + ")(globalThis)", ctx)` —
  `installDeterminismGuards` stays the single source of truth, embedded via
  `toString()` exactly as before), defines `agent`/`parallel`/`pipeline`/
  `phase`/`log`/`budget`/`args` non-writable on the context global and `meta`
  writable, then compiles the script with
  `vm.runInContext('(async function(){"use strict";\n' + script + '\n})', ctx,
  { filename: "workflow-script.js" })`.
- No `importModuleDynamically` option is passed, so `import()` — in the script
  body or through a nested `new Function` — throws "A dynamic import callback
  was not specified." on **both** runtimes (verified empirically on Node 22
  and Bun 1.4 before the change was wired in).
- The worker thread stays: `terminate()` remains the kill mechanism, and the
  bridge helpers (`agent`, `parallel`, `pipeline`, …) keep running in the
  worker realm — the context only needs their function references.
- `WORKFLOW_DESCRIPTION`, the guidelines and the README now say the guards
  remove clocks/randomness/timers/`process`/`require`/`fetch` and block
  dynamic import — that this prevents *accidental* reach, and is not a
  security boundary. The absolute "no network, no filesystem" claim is gone.

## Alternatives considered

- **Keep `AsyncFunction` and block `import` in `installDeterminismGuards`.**
  There is no global to stub — `import()` is syntax, not a value; it cannot be
  guarded from inside the realm.
- **Static-parse the script for `import(` before compiling.** A string check
  is trivially evaded (`const i = "imp" + "ort"` is not the real problem —
  `globalThis.eval`/`Function` compositions are), and a real parser is a
  dependency this plugin does not carry. The vm context refuses at the
  mechanism level instead of pattern-matching source text.
- **A subprocess with a denylisted environment.** Rejected before for the
  same reason it was rejected originally (second interpreter, broke under
  Bun); the vm context is additive to the worker, not a replacement.

## Consequences

`import()` of any specifier inside a script fails the run — that includes
legitimate use like `import("node:crypto")` for a hash, which is the point:
determinism means nothing outside `args` and agent calls may enter. The
`meta` global is now read back from the context, and cross-realm values flow
through `postMessage` as before — but `instanceof`/`Array.isArray` checks
inside a script see context intrinsics, so a value produced by a worker-realm
helper (e.g. `parallel`'s result array) is not `instanceof Array` inside the
script. Structured clone over the wire and property access are unaffected, and
the existing host/sandbox/end-to-end tests pass unchanged.

## Verification

- `plugins/workflow/test/host.test.ts` — "dynamic import() cannot reach node
  modules past the guards" (`return await import("node:fs")` fails, message
  mentions import) and "import() through a nested Function is blocked too".
- The same file's lifecycle/concurrency/shutdown tests pin that cross-realm
  results, `meta`, panels and pipelines still work.

Proved: with `plugins/workflow/src/host/worker-entry.ts` stashed,
`bun test plugins/workflow/test/host.test.ts` → 26 pass, 2 fail (both new
tests — the import succeeded and the run reported completed). After restoring:
28 pass, 0 fail. Under Node 22 a throwaway script driving `runScriptHost`
directly (type-stripped) reported `completed:false` /
"A dynamic import callback was not specified." for both `import("node:fs")`
and the nested-`Function` form, while a `parallel()`+`meta` script completed
with its value intact. Verified: vm contexts block `import()` without a
callback on both runtimes — confirmed before implementation, so the stop
condition did not trigger.
