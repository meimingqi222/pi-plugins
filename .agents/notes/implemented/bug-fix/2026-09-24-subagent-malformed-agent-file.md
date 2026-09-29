# Agent Note: One malformed agent file must not disable `subagent`

Status: implemented

## Problem

`readAgentFile` parsed a definition's frontmatter with `pi`'s
`parseFrontmatter`, which runs a real YAML parser and **throws** on a syntax
error. The call was not guarded, and `discoverAgents` walks the whole agents
directory without a per-file try/catch, so a single malformed file under
`~/.pi/agent/agents/*.md` — one unbalanced bracket, e.g. `tools: [read` — threw
out of `discoverAgents()`.

Discovery runs on every `subagent` tool call, so the effect was not "this agent
is unavailable" but "the tool is broken": every call failed, and no other agent
could be listed or used until the user found and fixed the offending file. The
module's own comment claims a bad file must not take the others down; the
`parseToolList` path honored that, the YAML path did not.

## Decision

Wrap the `parseFrontmatter` call in a `readFrontmatter` helper that returns no
frontmatter on a parse failure. An unusable file is then skipped by the existing
`typeof frontmatter.name !== "string"` check, exactly like any other unusable
file — one bad file costs only that file.

A file that does carry a name is still read when it has no description of its
own, provided the name matches a built-in: that case is now a partial override,
not a broken definition, and the description is inherited. What stays strict is
what the merge in `agents.ts` must not relax — a malformed explicit `tools`
allowlist still skips the file whole
(`2026-09-27-subagent-builtin-agent-overlay.md`).

## Alternatives considered

**Let the throw propagate and report it.** Rejected: a user file is not a
plugin bug, and failing every delegation because one of them is malformed is a
worse outcome than skipping it. Pi's own skill loader makes the same choice.

**Report a diagnostic warning.** Deferred: there is no diagnostics channel on
this tool today, and silently skipping matches how every other unusable agent
file is already treated. A warning would be an improvement, not the fix.

## Consequences

Agent discovery is total: any directory contents produce the built-in `explore`
plus the files that parse. A syntax error is now invisible — the file simply
does not appear — which is the same treatment a missing `name` already got.

## Verification

- `plugins/subagent/test/agents.test.ts` — test "a malformed frontmatter file does not take discovery down with it": `readAgentFile` on the broken file is `undefined`, and `discoverAgents` still returns `explore` and the good file.

Proved: with the guard removed, the test failed calling `discoverAgents` with
`Flow sequence in block collection must be sufficiently indented and end with a
]`; with the guard restored it passes, and the full `pi-subagent` suite is green.
