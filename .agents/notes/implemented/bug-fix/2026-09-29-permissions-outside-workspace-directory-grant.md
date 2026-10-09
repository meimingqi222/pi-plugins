# Agent Note: Granting one directory from a dangerous outside-workspace delete

Status: implemented
Partly-superseded-by: 2026-10-09-permissions-yolo-auto-allow.md

## Problem

`rm -rf ~/.acemcp/data-acebench-old` is `dangerous / rm-recursive-force` because
the target is outside the workspace; seven of the 30 dangerous grades in the
recorded history are this shape (tool caches under `~`, `~/Library/Saved
Application State/…`, another checkout's `__pycache__`).

Two things made it worse than a single click:

- `decide.ts` returns `allowAlwaysOffered: false` for `dangerous`, so the prompt
  offered only "Allow once" and "Deny" — there was no way to stop being asked
  short of hand-editing the config file;
- a delegated child or `--mode json` run cannot be asked at all, so the call is
  denied outright with no hint that `additionalDirectories` is the way out.

The escape hatch already existed and was simply invisible: `hitRmRecursiveForce`
counts `additionalDirectories` as scratch (verified: the same command grades
`grey` once `~/.acemcp` is added). minimax-code's `isWriteAuthorizedTarget`
authorizes exactly this shape — workspace + `allowedWorkingPaths` (user-selected
directories, fed from `pluginContext.directories`) + user write-allow rules —
which is the same "a directory the user vouched for" idea.

## Decision

For a dangerous call, compute the one directory a grant would fix and offer it:

```ts
function grantableDirectory(classification, env): string | undefined
```

It takes the parent of every target of a dangerous `rm` that sits outside
`env.cwd`, `env.additionalDirs` and `env.tempDirs`, and returns a directory only
when they all share one parent — so the grant can never be broader than the
deletion on screen. The prompt then offers

```
Always allow this directory: /Users/me/.acemcp
```

which persists `projects[<cwd>].additionalDirectories` into the global file
(`appendAdditionalDirectory`) and reloads state, so the *same* session stops
asking for the next target in that directory. The reason text also names the
knob, which is what a headless denial shows.

## Alternatives considered

**Basename heuristics for `__pycache__`, `node_modules`, `.cache`.** Neither
upstream has any build-artifact notion, and a basename rule cannot tell
`__pycache__` from `~/.acemcp/data-*` — a tool's *data* directory, the very
command being asked about. It would trade a prompt for silent data loss.

**Only document the config knob (no prompt option).** Ten lines instead of
sixty, but the headless case stays blocked and the knob stays undiscoverable
from the dialog the user is looking at.

**Let a `bash(rm -rf ~/.acemcp:*)` allow rule cover it.** Rules cannot lift the
dangerous tier by design, and a prefix rule is not path-scoped: it would also
match a command that deletes something else in the same directory.

**Grant the target itself instead of its parent.** `rm -rf ~/.acemcp/data-old`
would then be allowed once and `data-new` would ask again — useless for the
repeated cold-run/cleanup pattern this came from.

## Consequences

A grant is directory-wide, matching how `allowedWorkingPaths` works upstream:
one click makes that directory scratch for every future delete. The option only
appears when there is exactly one coherent parent, and the label names the
directory, so the consent is informed. Tiers and the rule table are unchanged —
`rm -rf` of the workspace root, a system tree, or an ambiguous multi-directory
set still asks with no grant option.

This depends on `projects[<cwd>]` being read with the same key it is written
with; see `2026-09-29-permissions-project-key-realpath.md`, which this work
uncovered.

## Verification

- `plugins/permissions/test/plugin.test.ts` — a dangerous
  `rm -rf ~/Library/Caches/pi-perm-grant/data-old` offers the directory option,
  persists it under `projects[<realpath'd cwd>].additionalDirectories`, allows the
  call, and the next `rm -rf` of a sibling in that directory runs with no second
  dialog; a dangerous call with nothing coherent to grant (`git push -f`) offers
  no such option.
- `plugins/permissions/test/config.test.ts` — `appendAdditionalDirectory` is
  idempotent and preserves the other fields of `projects[<cwd>]`.

Proved: stubbed `grantableDirectory` to `return undefined` →
`bun test plugins/permissions/test/plugin.test.ts` reported `24 pass, 1 fail`
with the grant case failing (`Expected: 1 / Received: 2` dialogs), then
restored → `25 pass, 0 fail`.


## Superseded

The classifier/path-boundary decision still holds. The universal dangerous
confirmation requirement, including claims that yolo asks or headless yolo
denies dangerous calls, is replaced by the successor: YOLO allows dangerous
classifications unless an explicit user rule restricts the call. Ask/auto
retain guarded confirmation and forbidden operations remain denied.
