# Agent Note: Share the poll-guard parser and registration

Status: implemented

## Problem

`pi-workflow` and `pi-bg-bash` each carried their own copy of the same
bare-sleep parser and the same `tool_call` gate:

- the regex `^\s*(?:sleep|start-sleep)\s+...` existed twice, and each copy's
  comment told the next editor to keep it in sync with the other;
- both filtered `bash` / `powershell` and read `event.input.command` with the
  same guard;
- only the policy differed: workflow blocks and terminates the batch because its
  completion always wakes the model; bg-bash blocks without terminating because
  a default successful job does not wake it.

A parser drift would be silent and user-visible: a command one plugin treats as
a poll and the other as real work. This is the same class of duplication that
`RunBudget` and `RunGuard` were extracted to remove.

## Decision

Move the parser and the tool gate to `pi-run-core`'s `createPollGuard(options)`.

- `active()` is consulted first: no live work means a sleep is an ordinary wait
  and is never blocked.
- `reason(ids)` is supplied by the plugin, so the message still names the run or
  job the model should inspect.
- `terminate` is a caller option, preserving the one real policy difference.
- The plugin `poll-guard.ts` files remain as thin re-exports of the parser plus
  their own `pollBlockReason`, so the existing plugin tests keep testing the
  wording they own.

## Alternatives considered

**Make the policy identical.** Terminating bg-bash's turn would strand a model
whose default successful job never wakes it; not terminating workflow's turn
would leave it polling until the result arrives. The difference is load-bearing.

**Share only the regex via a constant.** Leaves the registration, tool-name gate
and input-shape check duplicated, which is where the second copy already drifted
in ordering (workflow checked `activeCount`, bg-bash filtered running background
jobs).

**Move `pollBlockReason` into run-core too.** The wording is policy: it names
`workflow_status` or `bg_tasks wait`. A generic sentence would be worse for both
users.

## Consequences

One parser, one tool gate, one ordering rule. Each plugin supplies only its live
ids and its policy. `createPollGuard` is a library function, not an extension —
no registration happens unless a plugin calls it.

No user-facing behavior change: the existing plugin poll tests pass unchanged,
including the terminate/no-terminate distinction.

## Verification

- `plugins/run-core/test/poll-guard.test.ts` — parser cases, no active work,
  block reason and ids, terminate option, purposeful command, non-shell tool.
- `plugins/workflow/test/poll-guard.test.ts` and
  `plugins/bg-bash/test/poll-guard.test.ts` — the existing policy tests, now
  exercising the re-exported parser through each plugin's own reason.

This is an equivalence refactor; there is no red run to record. The tests pin
the shared contract instead. The prior duplication is visible in the two deleted
regex copies in this change's diff.
