# Agent Note: Terminate the workflow worker once and wait for its exit

Status: implemented

## Problem

On Windows, every workflow run that was stopped — by the script timeout, by an
external abort, or by `/workflows stop` — hung forever. `host.test.ts` and
`orchestrator.test.ts` reported their assertions as passing and then never
printed a summary line, and the `plugin-wiring` stop test never saw its result
within the 10s wait, so `bun run test` could not complete.

The host reached the worker's `terminate()` from two places. The abort listener
fired it eagerly with `void kill()`, and the `finally` block awaited `kill()`
again. Node tolerates a second `terminate()`. Bun does not:

- terminate a worker that is still running → the promise resolves;
- terminate one that has already exited → the promise never settles.

By the time `finally` ran on an abort path, the eager call had already
terminated the worker, so the second `terminate()` was exactly the
never-settling case. `await kill()` parked the run forever, which is why the
tests looked all-green and then hung instead of failing.

## Decision

Request termination at most once, and have `kill()` wait on the worker's `exit`
event rather than on `terminate()`'s promise:

```ts
let terminateRequested = false;
let resolveExited!: () => void;
const exited = new Promise<void>((resolve) => {
  resolveExited = resolve;
});
const kill = async (): Promise<void> => {
  if (!terminateRequested) {
    terminateRequested = true;
    void worker.terminate().catch(() => undefined);
  }
  await exited;
};
```

`exit` is emitted on both runtimes whether the worker was terminated by us or
ended on its own, so it is the honest signal that the thread is gone. The
promise `terminate()` returns is still issued, but its resolution is no longer
load-bearing.

## Alternatives considered

**Await `terminate()` only in `finally` and fire-and-forget in the abort
listener.** That is what the code already did; the `finally` await is the hang.

**Do not await termination at all.** Removes the hang, but drops the guarantee
that the run does not return while a worker is still winding down, and leaves a
rejected `terminate()` promise unhandled.

**Race `terminate()` against a timer.** A second timer added to fix a hang is a
third way to hang; `exit` already reports exactly the event needed.

**Detect the runtime and special-case Bun.** The `exit`-based wait is correct on
both runtimes, so no branch is needed.

## Consequences

Stopping a run settles on both runtimes. The host now states its third
settlement rule in `plugins/workflow/src/host/bridge.ts`, because a future
cleanup that "simplifies" `kill()` back to `await worker.terminate()` would
reintroduce a hang that only Bun shows.

The same change fixed a second, independent Windows failure in
`plugins/workflow/test/journal.test.ts`: its expected workflow root was built
with `join("/tmp/project", ".pi", "workflows")`, which does not agree with
`path.resolve("/tmp/project")` about the drive on Windows (the test expected a
drive-less path, the code produced `D:\tmp\project\.pi\workflows`). It now uses
an absolute temp-directory fixture, so it pins the `.pi/workflows` layout rather
than the host's drive.

## Verification

- `plugins/workflow/test/host.test.ts` — the `script host shutdown` block, whose
  timeout, never-resolving-agent, and external-abort cases all previously parked
  the run in `finally`
- `plugins/workflow/test/orchestrator.test.ts` — the run-level stop paths above
  the host
- `plugins/workflow/test/plugin-wiring.test.ts` — the `/workflows stop` case
  that now receives the aborted run's delivered result
- `plugins/workflow/test/journal.test.ts` — the platform-neutral workflow-root
  expectation

Proved: `timeout -k 5 30 bun run` on a two-line probe that aborted a host whose
agent callback returns a promise that never resolves hung until the hard kill;
after the change it returned
`{"completed":false,"stopReason":"timeout","errorMessage":"stop it"}` in two
milliseconds. `bun test plugins/workflow/test/host.test.ts` before the change
stopped after 19 tests with no summary; after it, `23 pass, 0 fail`. The same
before/after holds for `orchestrator.test.ts` (`28 pass`) and
`plugin-wiring.test.ts` (`20 pass`).
