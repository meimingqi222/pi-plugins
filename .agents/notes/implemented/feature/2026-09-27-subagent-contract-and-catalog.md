# Agent Note: Delegation contract text, built-in catalog, aliases, and a wait action (P0)

Status: implemented

## Problem

`pi-subagent`'s call contract was thin in the three places the reference
implementations (Step-Code, minimax) are deliberate:

1. **Contract text.** The tool description and parameter descriptions are the
   only prompt surface a delegation gets — neither reference injects guidance
   into the system prompt. Ours named only `explore`, carried no delegation
   write-spec, no file-ownership rule for parallel children, and no
   anti-poll statement.
2. **Catalog.** One built-in (`explore`) meant every write task either went
   through an unspecialised child or needed a user file; there were no name
   aliases, and `general-purpose` — the name models actually reach for —
   failed as unknown.
3. **Lifecycle surface.** A caller that needed to block on a background task
   could only poll `show` in a loop — the exact anti-pattern the description
   needed to forbid, with nothing to offer instead. And children had no
   human-facing name beyond `sa-<uuid>`.

## Decision

**`src/catalog.ts`** holds `BUILTIN_AGENTS` (three, up from one — read is the
default, write is the explicit exception): `explore` (`read/grep/find/ls`),
`review` (`read/grep/find/ls/bash` — a review that cannot run the suite is a
guess), and `general` (unrestricted, the only built-in that edits).
`AGENT_ALIASES` maps `general-purpose`/`general purpose`/`general_purpose` to
`general`; `resolveAgent` resolves exact-then-alias so a user file owning the
alias spelling keeps its own name. `formatAgentGuidance` derives the
description's built-in list from the catalog so the text cannot drift.

**`src/contract.ts`** is the single source for the contract text:
`SUBAGENT_DESCRIPTION` now carries the dynamic built-in list, the
disjoint-files rule ("Parallel background children must own disjoint files;
otherwise serialize"), and the anti-poll rule ("do not poll `subagent_tasks`
in a loop — use its wait action"). `TASK_PARAM_DESCRIPTION` is a shrunk
delegation write-spec (goal / paths / ruled-out approaches / file ownership /
deliverable / acceptance / answer shape). `tool.ts` re-exports both constants
so existing imports keep working.

**`src/background.ts`** — `BackgroundRecord` gains a required `alias`
(human-facing name), `deriveAlias(task)` builds a bounded slug from the
task's first line when none is passed (split before control-char stripping —
replacing `\n` first made `split("\n")` a no-op, a real bug caught by the
catalog test), and `waitFor(sessionId, id, timeoutMs)` resolves on settle or
deadline through a `waiters` set the existing `settle` path drains — a
subscription, not a poll.

**`src/index.ts`** — the `subagent` tool gains `alias`, launch resolves the
canonical name through `resolveAgent` before recording, and `subagent_tasks`
gains `action: "wait"` (`timeout` 0–30s, default 30).

**`src/fleet.ts`** — the widget row's kind column and the detail header show
`alias` (falling back to agent), so a fleet reads as named work rather than
`sa-*` ids.

## Alternatives considered

- **`tasks[]`/`chain[]` parameters** — rejected in the plan: composition is
  `pi-workflow`'s job; the unary contract is the correct primitive.
- **A `wait` that polls `registry.get`** — subscription matches `bg_tasks
  wait`'s shape and cannot be tuned into a busy loop by accident.
- **`agent:` URI disambiguation (minimax)** — unnecessary: file precedence
  already resolves collisions; there are no runtime agent entities.
- **Separate `subagent_send` tool for reply** — deferred to P2 with the RPC
  transport it needs; `wait` ships now because it needs no transport change.

## Consequences

`subagent` calls name three built-ins and resolve `general-purpose`; the
description carries the ownership and anti-poll rules at the exact place the
model reads them. `wait` gives the sanctioned way to block. Every record has
a human name. `deriveAlias` splitting before sanitising is pinned by test.

## Verification

- `plugins/subagent/test/catalog.test.ts` — the 3-builtin shape, exact-before-
  alias resolution, alias-only-reaches-builtins, description/catalog drift,
  `deriveAlias` bound and the newline-split order.
- `plugins/subagent/test/plugin.test.ts` — `wait` resolves on settle, a
  `timeout:0` wait returns immediately, an unknown id reports; `alias` is
  recorded from the param and from the task slug.
- `plugins/subagent/test/agents.test.ts` — expectations updated for three
  built-ins (missing-dir returns catalog insertion order, not sorted).

Proved: removing `resolveAgent`'s alias fallback fails the alias tests;
reverting `deriveAlias`'s split order fails its newline test. 85 tests pass,
`bun run typecheck` clean.
