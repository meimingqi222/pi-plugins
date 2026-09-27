# Agent Note: A run's error is the last reply's error, not every error ever seen

Status: implemented

## Problem

`applyEvent` folded an assistant error into `StreamState.errorMessage` and never
cleared it, while `finalText`, `stopReason` and `model` were all replaced on
every `message_end`. `finish()` reads that field as a run-level verdict:

```ts
} else if (state.errorMessage) {
  outcome = { status: "failed", errorMessage: state.errorMessage, ... };
}
```

So one errored reply poisoned every later one: a run that produced a complete
answer after recovering was reported as `failed` with the *stale* error text, and
the answer was thrown away — the tool result became `Agent "x" failed: 429: …`
instead of the work that was actually done.

**How reachable is it?** Not through provider retries, which is where it looked
like it would bite: `retryAssistantCall` in `pi-ai` consumes a retryable failure
*inside* its own loop and returns only the final response, so an intermediate
failure never becomes an assistant message and never reaches this fold. The
reachable paths are narrower:

- a multi-turn RPC lane whose turn ended in a terminal error (retries exhausted,
  or a non-retryable error) and whose *next* turn succeeded — the lane's answer is
  that later turn's, and the run reported the earlier one's failure;
- the context-overflow recovery path, which removes the failed assistant message
  and retries the turn — the failed message was already emitted on the stream
  before removal.

Both are uncommon, which is why this is a latent bug rather than a reported one.
The fix is worth making anyway because the failure mode is the worst kind:
discarding good work and reporting it as a failure, with a message that describes
something that is no longer true.

## Decision

**Make `errorMessage` follow the same last-wins rule as the fields beside it.** A
`message_end` that carries no error clears the field, so the run's verdict comes
from its last reply:

```ts
if (typeof message.errorMessage === "string" && message.errorMessage) state.errorMessage = message.errorMessage;
else delete state.errorMessage;
```

The rule is already the one the fold states for `message_end` ("authoritative;
replace rather than append") — `errorMessage` was simply the one field that did
not follow it.

## Alternatives considered

- **Track the error only from the last assistant message**, e.g. by recording a
  message index. Equivalent in outcome, more state, and it would have to be kept
  in step with the `agent_end` replay path — the last-wins assignment gets the
  same answer for free, including through the replay.
- **Treat any error as terminal and stop folding.** That is closer to pi's own
  behaviour, but the fold cannot stop a child: the process is already running and
  will keep emitting. Reporting the run's real last state is the honest option.
- **Leave it and document the trigger.** The state is wrong; documenting a wrong
  state is worse than the two-line fix, and the fix has a deterministic test.
- **Clear the error on `agent_end` instead of on `message_end`.** `agent_end` is a
  turn boundary under the RPC transport, not the run's end, so this would clear a
  genuine error from the final turn whenever a lane went idle afterwards.

## Consequences

A lane that recovered is reported as completed with its real answer, and a lane
whose last reply failed is still reported as failed with that reply's error —
including when the failure is the run's only event. `stopReason` and
`errorMessage` now agree, which removes a class of "failed but has a full answer"
results.

The change is in the shared fold, so `pi-workflow` agents get it too.

## Verification

- `plugins/agent-runner/test/spawn.test.ts` — "a later successful reply clears an
  earlier error" (unit: error then success clears, success then error keeps, so
  the rule is last-wins in both directions).
- `plugins/agent-runner/test/executor.test.ts` — "a run that recovered after a
  terminal error is completed, not failed" (end-to-end through the fixture's
  `RECOVER` prompt: the outcome, the text and the usage must all come from the
  recovered reply).

Proved: with the `else delete state.errorMessage` branch removed, both tests fail
— the unit test on the stale `errorMessage`, and the executor test in 19ms
because the run is mapped to `failed` with `429: rate limited` instead of
`completed`. Restoring the branch turns both green; the other 58 `agent-runner`
tests are unaffected.
