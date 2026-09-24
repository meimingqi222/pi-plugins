# Agent Note: A launched background subagent is not a failure

Status: implemented

## Problem

`renderResult` derives a display status and then a theme colour:

```ts
const status = isPartial ? "running" : details.taskId ? "launched" : details.status;
const color = status === "completed" ? "success" : status === "running" ? "accent" : "error";
```

A background launch returns its handle immediately with `status: "running"` and a
`taskId`, so `status` becomes `"launched"` — a label the colour table did not
know. It fell through to `"error"`, and a task that started successfully rendered
in the failure colour. That red line is the one signal a user reads as "this
died", so the most common background outcome looked like a crash.

The existing render test could not catch it: its stub theme ignores the colour
and returns only the text.

## Decision

Treat `"launched"` as `"accent"`, like `"running"`. The label stays distinct
(it says the call returned before the child finished, which `"running"` does not
say on its own); only the colour mapping widens.

## Alternatives considered

**Drop the `"launched"` label and show `"running"`.** Rejected: the immediate
handle and an in-flight progress update are different facts, and the label is
what distinguishes them.

**Colour `"launched"` as `"success"`.** Rejected: nothing has succeeded yet. The
child may still fail, and the settled message carries the real status. Accent
matches "in flight", which is what a launch is.

## Consequences

A background launch renders in the same accent as a running foreground call. No
other status is affected: an unknown future label would still fall through to
`"error"`, which is the fail-loud default.

## Verification

- `plugins/subagent/test/plugin.test.ts` — test "a launched background task is not painted as a failure": a background handle renders with the label `launched` and a theme that records colours is never asked for `"error"`.

Proved: before the fix the test failed with `Expected to not contain: "error"`,
`Received: [ "error" ]`; after the fix it passes.
