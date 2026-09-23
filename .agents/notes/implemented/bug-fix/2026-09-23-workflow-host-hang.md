# Agent Note: Make the workflow script host terminate instead of hanging

Status: implemented

## Problem

Stage 2's script host hung three separate times during development, each time
taking the whole session with it. All three were the same class of mistake —
**waiting for something that would never happen** — and the second and third were
introduced while fixing the first.

**Hang 1: the child kept itself alive.** The first host spawned a subprocess whose
entry installed a `process.stdin.on("data")` listener. That listener was the only
thing holding the event loop open, so after writing `complete` the child stayed
alive waiting for input. The parent awaited the child's stdout end. Neither side
could proceed:

```
parent: await stdout-end   ← waits for the child to exit
child:  listening on stdin ← waits for input that never comes
```

**Hang 2: the timeout did not kill the child.** `controller.abort()` only set a
signal. Nothing was subscribed to it, so the 30-minute default timeout could not
stop a run either. A `while (true) {}` script was unstoppable.

**Hang 3: the worker was awaited after being abandoned.** After moving to a worker
thread, settlement still waited on an `exit` event that a worker holding its own
`parentPort` listener never emits, and then awaited abandoned agent handlers that
ignored their abort signal. The `terminate()` that would have resolved both was
only called in the `finally`, which is reached after the await that hangs.

Underneath all of it: a subprocess host was the wrong transport to begin with. Bun
as a spawned child with piped stdio has `stdin === undefined`, so the handshake
crashed on the first write.

## Decision

Replace the subprocess with a `node:worker_threads` worker, and settle on the
first terminal signal rather than on the worker exiting.

Measured on both Node and Bun: a worker running `while (true) {}` is terminated in
under 25ms. That is the property a subprocess was chosen for, without a second
interpreter, a temp entry file, or a framed wire — and it works on Bun, which the
subprocess did not.

Three rules, each corresponding to a hang:

- **Settle on the first of `complete`/`error` message, `exit`, or worker `error`**,
  then terminate the worker. Never await an `exit` that a live listener prevents.
- **Subscribe the abort signal to `terminate()`**, and check `aborted` before the
  timeout is armed, so a signal that already fired still kills.
- **Skip the handler drain once aborted.** A callback that ignores its signal must
  not hold the run open; the worker is gone, so its result is unreachable anyway.

The worker source embeds `installDeterminismGuards.toString()` rather than a copy,
so `sandbox.ts` stays the single source of truth. Scripts run with `"use strict"`
so an assignment to a guarded global throws instead of silently doing nothing —
the guard held either way, but a silent no-op hides that from the author.

## Alternatives considered

**Fix the subprocess.** It breaks under Bun as a spawned child, which is not a bug
in this repository and cannot be worked around from here. A host that works from
source and fails in a shipped binary is worse than no host.

**`isolated-vm`.** Rejected in stage 1: the native addon cannot load in pi's
`bun --compile` binary.

**Keep the worker but wait for `exit` after `complete`.** That is hang 3.

**Cap the drain with a timeout instead of skipping it.** Adding a second timeout
to fix a timeout problem adds a third way to hang. The drain is skipped because
after an abort it cannot produce anything useful, not because it is slow.

## Consequences

A runaway script costs a terminated worker, not a stuck session. `timeoutMs` is now
load-bearing rather than decorative, and every host test passes a short one — a
regression in settlement fails the suite instead of hanging it, which is what
surfaced hang 3.

`ScriptHostOptions` no longer takes `runDir` or `cwd`: a worker is not a process
and has no working directory of its own.

## Verification

- `plugins/workflow/test/host.test.ts` — 19 tests
- `plugins/workflow/test/sandbox.test.ts` — 9 tests, including that the guard
  function survives being stringified into a worker

`66 pass, 0 fail` across the workflow suite; `451 pass, 0 fail` workspace-wide.

Proved: the timeout is real rather than merely recorded:

- `a runaway script is killed by the timeout instead of hanging the run` asserts a
  `while (true) {}` settles with `stopReason: "timeout"` in under 8s at a 1.5s cap.
- `a blocked child that never writes is killed by the timeout` covers the other
  shape: a script awaiting an agent that never resolves.
- `an external abort signal kills the run` covers the signal path independent of
  the timer.

A blob-parse probe (`node --check` on `renderWorkerSource()` output) exists because
a template-escaping mistake in the `"use strict"` directive made the whole worker
fail to compile, which presented as all 19 tests failing with
`3 errors building blob:`. The probe is recorded here rather than kept as a test:
it catches a build-time class of error that the host tests already surface less
directly.
