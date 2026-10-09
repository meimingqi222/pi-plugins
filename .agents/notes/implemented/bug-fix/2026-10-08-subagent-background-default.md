# Agent Note: Default delegation to background execution

Status: implemented

## Problem

Omitting `background` selected a blocking foreground call. Besides keeping the
parent waiting, Paseo's native adapter associated its child transcript only at
settlement. The user requested background as the default while retaining an
explicit blocking mode for dependent work.

## Decision

Only `background: false` selects foreground execution. Omitted or true selects
the existing background path, with its immediate task handle, RPC lifecycle,
launch-time host transcript and completion delivery. The parameter schema,
tool description, LLM guidelines and documentation all name the same default.
Foreground transport and concurrency tests now request false explicitly.

## Alternatives considered

- Set only the schema default: direct calls can omit the property, and JSON
  schema metadata is not guaranteed to materialize optional defaults.
- Force every call into the background: removes the requested blocking option.
- Patch Paseo: outside the authorized scope and unnecessary for this default.

## Consequences

Existing callers that omit the parameter receive a handle instead of an answer
in the launch result. They must wait through subagent_tasks or consume the
completion message. Background limits and disjoint-file ownership rules still
apply. Native child pages can follow completed messages during execution on
supporting hosts; token-level output remains available in the companion
screen. Reload Pi to refresh both execution behavior and model-facing schema.

## Verification

- `plugins/subagent/test/plugin.test.ts` checks omitted, true and false with an
  unfinished child: only false blocks until the answer is ready.
- `plugins/subagent/test/paseo.test.ts` checks that an omitted-background RPC
  launch exposes a transcript file before the child finishes.
- `plugins/subagent/test/transport.test.ts` and
  `plugins/subagent/test/lane-reply.test.ts` retain explicit foreground
  transport, concurrency and cancellation coverage.
- `plugins/goal/test/lifecycle.test.ts` checks explicit foreground usage
  reporting and default-background settlement before goal verification.

Proved: before changing execution, `bun test
plugins/subagent/test/plugin.test.ts -t 'execution mode'` reported 2 pass / 1
fail. The default-mode launch did not return before the child completed
(`expect(early).not.toBeNull()` received null). With the new default all three
cases pass without changing the explicit foreground expectation.
