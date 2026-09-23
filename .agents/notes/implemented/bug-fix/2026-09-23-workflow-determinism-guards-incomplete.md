# Agent Note: Complete the workflow determinism guards

Status: implemented

## Problem

The worker removes the sources of non-determinism that would break journal
replay. `FORBIDDEN_GLOBALS` and the `names` array inside
`installDeterminismGuards` listed `process`, `require`, `fetch`, `setTimeout` and
`setInterval`, and the function separately replaced `Date`, `Math.random` and
`Intl.DateTimeFormat`. Three sources were missed, and any one of them defeats the
guarantee the guards exist to provide, because a workflow is replayable only if
the same script and args produce the same calls:

- **`crypto`** — `randomUUID()` and `getRandomValues()` are a second source of
  randomness, reachable from any worker.
- **`performance`** — `performance.now()` is a third clock, after `Date` and
  `Intl.DateTimeFormat`.
- **`setImmediate`** — the scheduler the list already removes in its
  `setTimeout`/`setInterval` forms.

A script that varied a prompt by `crypto.randomUUID()` would journal a different
call hash on every run, so resume never matched and the journal stopped meaning
anything — the exact failure the module's own doc comment describes.

The `FORBIDDEN_GLOBALS` constant and the `names` array were separate literals, so
the published list of what is removed could disagree with what is actually
removed. It did: `crypto` and `performance` were in neither, and nothing pinned
the two together.

## Decision

- **Add `crypto`, `performance` and `setImmediate` to the removed globals**, in
  the array that does the work.
- **Capture the real `setImmediate` before installing the guards.** The worker's
  own terminal flush schedules through `setImmediate` to give queued
  `postMessage` calls a tick to drain; removing the global after that point would
  have taken the scheduler away from the host code too, and the `complete` message
  would never be sent. The worker body now reads `const scheduleFlush =
  setImmediate;` above the guard call and uses `scheduleFlush` for both flushes.
- **Test the constant against the behavior.** One test asserts every name in
  `FORBIDDEN_GLOBALS` is gone from the target, so the list and the loop that
  applies it can no longer drift.

## Alternatives considered

**Keep the `names` array as the only source and test only it.** The array is what
executes, so it is the one that must be right; `FORBIDDEN_GLOBALS` is the
published contract. Testing the constant against the target makes them one list
in effect, without a refactor that would have to move the array out of the
function — which `Function.prototype.toString()` embedding forbids, since anything
the function closes over is `undefined` in the worker.

**Leave `setImmediate` in place rather than capture it.** It is the least
dangerous of the three: it is a scheduler, not a clock or a randomness source. It
is still a way to vary ordering between a run and its replay, and the list already
removes its two siblings; the capture is four lines and keeps the rule uniform.

**Block the whole `crypto` object instead of specific methods.** What was done —
`crypto` is set to `undefined`, so there is no object to reach methods on.

## Consequences

The guards now cover every source the module's rationale names. A script that
reached for `crypto.randomUUID()` or `performance.now()` now throws
`workflow-determinism:` instead of silently producing a run that cannot be
resumed.

The worker's terminal flush depends on a captured reference rather than a global,
so the two are coupled: the guard list is the reason the capture exists, and a
future edit that removes `setImmediate` from the list should also remove the
capture. A comment at the capture states that.

This is still not a security boundary, and the module says so. `crypto` is
removed for reproducibility, not to contain a script — pi extensions run with the
user's permissions.

## Verification

- `plugins/workflow/test/sandbox.test.ts` — `crypto`, `performance` and
  `setImmediate` are removed, and every name in `FORBIDDEN_GLOBALS` is gone from
  the target
- `plugins/workflow/test/host.test.ts` — inside the real worker, `crypto` and
  `performance` are undefined, `crypto.randomUUID()` and `performance.now()`
  throw, and the script still reaches `complete`

The second test is the one that pins the capture: if the guards removed
`setImmediate` and the worker's flush still used the global, the run would end
without a terminal message and the test would fail on `result.completed`.

`237 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: the three names removed from the applying array returned the failures
directly.

- `installDeterminismGuards > removes the capability globals` failed on
  `crypto`, so the loop is bound to the list rather than to a stale copy of it.
- `installDeterminismGuards > covers every non-determinism source the guard list
  names` failed, which is the assertion that ties `FORBIDDEN_GLOBALS` to the
  target.
- `script host determinism guards > the second clock and the second randomness
  source are unavailable too` failed inside the real worker, so the guard is
  pinned at the boundary where a script meets it, not only in the unit.

Restoring the names returned all three to green.
