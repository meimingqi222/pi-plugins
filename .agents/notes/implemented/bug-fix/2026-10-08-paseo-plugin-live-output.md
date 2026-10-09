# Agent Note: Open a plugin-owned subagent live output screen

Status: implemented

## Problem

Foreground cards updated their activity but clicking the native child page
still showed no transcript until settlement. Paseo registers foreground child
files only after the tool returns; completed-message background files also
omit unfinished text deltas. Changing the host source is outside scope.

## Decision

The companion registers its own screen and server RPC. Foreground status and
background launch text carry a bounded raw-log basename; the card opens the
screen directly. The server reuses the subagent evidence parser, reads a
bounded tail under the configured log root and denies traversal and symlinks.
The screen polls without overlap, follows output optionally, retries failures
and ignores late responses after navigation. No provider events are forged.

The parser replaces text deltas with authoritative completed messages and
pairs incremental tool output with its final result. Public package subpaths
keep the server dependency inside Paseo's declared package module boundary;
the parser is independent of executor and TUI imports.

## Alternatives considered

- Patch Paseo's native child navigation or provider adapter: forbidden scope.
- Convert foreground launches to background work: changes answer delivery.
- Add a progress card per delta: floods the timeline and still has no transcript.
- Read an arbitrary client-supplied path: exposes unrelated local files.

## Consequences

Both Pi extension and companion must be updated. Old cards lack the new log
reference. The native child page remains host-controlled. Custom log-root
environment settings must match in Pi and Paseo. The view is a bounded tail,
not an archival transcript; omitted history is labeled. Polling continues only
while this screen is mounted so follow-up background turns remain observable.

## Verification

- `integrations/paseo-ui/test/live-output.test.ts` pins pre-settlement deltas,
  authoritative completion, tool partial/final output, filesystem boundaries,
  bounded tails, polling retry and navigation cleanup.
- `integrations/paseo-ui/test/status.test.ts` pins both entry paths and legacy
  status compatibility.
- `integrations/paseo-ui/test/contribution.test.ts` pins card-to-screen routing.
- `plugins/subagent/test/host-progress.test.ts` pins the foreground reference.

Proved: before implementation, `bun test
integrations/paseo-ui/test/live-output.test.ts` failed with 0 pass / 1 fail:
the live reader module was absent. After adding the reader, the same tests
passed, including unfinished output and duplicate replacement. The actual
Paseo daemon successfully reloaded the client/server plugin contributions.
Browser verification with the actual React components and reader confirmed
card navigation, pre-settlement text/tool updates, follow toggle and return
navigation at desktop and 375 px mobile widths in light/dark themes, with no
horizontal overflow. Host React Native primitives were adapted to DOM only
for this browser harness; a real provider-driven run in the installed app
still requires the parent Pi extension to be reloaded.
