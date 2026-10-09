# Agent Note: Publish an append-only background child transcript at launch

Status: implemented

## Problem

Subagent output files were published only at settlement. Paseo could identify
a running child, but its child page had no transcript to follow until the work
finished. Passive custom messages cannot solve this during a parent turn:
Pi defers them. Paseo's running subagent tool adapter also maps progress to
`sub_agent.log`, rather than the generic tool output field.

## Decision

RPC background spawn results carry an `Output file:` line at launch. The file
starts with the task and appends bounded completed assistant/tool messages as
they arrive. Paseo's existing adapter attaches its file follower immediately.
Settlement appends the summary to the same file before publishing the final
status. Follow-up turns get a new file, announced through Paseo's existing
runtime child-session notification. Foreground progress cards use the host's
`sub_agent.log` mapping, as recorded in the status-tool-rows note.

## Alternatives considered

- Publish a new snapshot on every progress tick: creates many files and does
  not let a follower stay attached to one append-only source.
- Wait for passive custom messages to flush: preserves the reported delay.
- Change foreground calls into background launches: changes model-facing
  execution and answer delivery semantics merely to register a host file.
- Change Paseo's adapter: outside the authorized scope.

## Consequences

Live background files are private, bounded to the host's byte/item budget,
and closed per turn. Existing foreground immutable snapshots remain supported.
Filesystem errors cannot fail child execution. Completed messages stream;
individual model text tokens are not copied into the child file.

The referenced Paseo source registers foreground child files only after the
blocking spawn call returns. Foreground parent cards can update during a run;
the native foreground child page still cannot hydrate early without a host
adapter change. Older hosts without file following show the transcript at
settlement. No Paseo source is modified.

## Verification

- `plugins/subagent/test/host-transcript.test.ts` pins launch-time availability,
  append-only updates, terminal summaries, private permissions, turn rotation
  and bounded output.
- `plugins/subagent/test/paseo.test.ts` verifies the actual extension's
  background launch exposes a readable file before the child completes.

Proved: adding the live transcript regression before implementation made
`bun test plugins/subagent/test/host-transcript.test.ts` report 1 fail and 3
pass because `startLive` was absent. After implementation all cases pass.
A separate integration check imported the actual Paseo adapter and file
follower from the reference checkout and verified a running foreground card,
background tool call, background tool result and final settlement in order.
