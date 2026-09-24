# Agent Note: A workflow child could start another workflow

Status: implemented

## Problem

A workflow agent is a separate pi process, and the spawn deliberately does not
pass `--no-extensions` — a child may legitimately be asked to use an ambient
extension. Ambient extensions therefore load in the child, including
`pi-workflow` itself, because the child environment set only
`PI_GOAL_DISABLE=1`.

`pi-workflow` already had an env switch for this (`PI_WORKFLOW_DISABLED`, read by
`workflowsDisabled()` in `src/pi/index.ts`), but nothing set it for the plugin's
own children. A child that decided to fan work out could therefore start a
workflow of its own, and each level could start another.

The per-run counters do not compose across that tree. The 64-agent default, the
provider concurrency ceiling, and the four-active-runs cap are all counted in one
process; a grandchild is a second process with its own counters. The result is
fan-out that no single limit bounds — the failure Step-Code names in its own
one-level rule, where `STEP_DISABLE_WORKFLOW=1` in a subagent child exists exactly
to stop a wave of workflow agents from multiplying concurrent provider streams
past the account limit.

A second, smaller defect in the same change: the `workflow` tool's guidance told
the model to prefer "a single subagent for one delegated task" without an opt-in.
No subagent tool ships in this workspace, so the guideline pointed at a tool the
model could not call. The wording was ported from Step-Code, where a first-class
`Agent` tool exists.

## Decision

The child environment sets `PI_WORKFLOW_DISABLED=1` and `PI_SUBAGENT_DISABLE=1`
in addition to `PI_GOAL_DISABLE=1`, so **fan-out is one level deep**: a child
registers no `workflow` surface and no `subagent` surface. The switches are the
same variables the owning plugins already read.

The contract now lives in `pi-agent-runner`'s `SCHEDULER_DISABLE_FLAGS`, applied
by `agentChildEnv()` at the one place a child is spawned. It moved there when the
runner was extracted so `pi-workflow` and `pi-subagent` share it rather than each
carrying a copy; adding a fourth scheduler is a one-constant change, and no
plugin has to know which other plugins exist. Each plugin's test still composes
the two halves — the shared environment with its own `*Disabled()` reader — so a
flag dropped by the runner fails the plugin that depends on it.

The guideline now names only tools that exist here (`grep`/`read` for a lookup, a
direct edit); `pi-subagent` is the owner of the "single delegated task" path.

## Alternatives considered

**A depth counter in the environment** (`PI_WORKFLOW_DEPTH`, allowing N levels).
Rejected: there is no use case for nested fan-out, and a depth cap still admits
"multiply by N" — it bounds the tree's height while leaving its width unowned.
Step-Code settled on a hard one-level rule for the same reason.

**Rely on the provider concurrency ceiling or the active-run cap.** Rejected:
both count within one process, so a child is a second, independent source. The
ceiling is not a global ledger, and treating it as one is exactly the mistake
this note fixes.

**Pass `--no-extensions` to every child.** Rejected: children are sometimes asked
to use an ambient extension, which is why the flag is absent; and it would not
compose with the existing `PI_GOAL_DISABLE` contract, which is honored by the
plugin rather than by the launcher.

**Have the child ask a parent-side registry before fanning out.** Rejected: pi
core has no subagent or cross-process child primitive, so the spawn environment
is the only channel a parent has to tell a child what it is. This is the same
constraint recorded in `2026-09-23-goal-hardening-from-four-products.md`.

## Consequences

Fan-out is one level deep. A workflow child registers neither `pi-goal` nor
`pi-workflow`, so it can neither resume the parent's objective nor start a
workflow of its own; both are properties of the user's session that a delegated
process has no standing to own.

The one-level rule lives in one constant — `SCHEDULER_DISABLE_FLAGS` in
`pi-agent-runner` — and one function applies it at the spawn site. It names all
three scheduling plugins' switches, so adding a fourth means editing one place;
the rule is "a spawned process does not fan out again", not "one plugin is
disabled".

A child still loads every other ambient extension. The disable is per-scheduling
plugin, not a sandbox.

The `workflow` guideline shrinks by one clause. A model that would have reached
for a non-existent tool now reaches for a real one.

## Verification

- `plugins/workflow/test/child-guard.test.ts` — the composed contract:
  `workflowsDisabled(agentChildEnv({}))` is true.
- `plugins/subagent/test/plugin.test.ts` — the same composition for the other
  side (`subagentsDisabled(agentChildEnv({}))`).
- `plugins/agent-runner/test/child-env.test.ts` — the environment's exact shape,
  pinned once in the runner that owns it.

Proved: two red runs, one per switch.

- Removed `PI_WORKFLOW_DISABLED` from `SCHEDULER_DISABLE_FLAGS` in
  `plugins/agent-runner/src/executor.ts` → `plugins/workflow/test/child-guard.test.ts`
  (`a workflow child cannot start another workflow`) failed.
- Restored it and removed `PI_SUBAGENT_DISABLE` instead →
  `plugins/subagent/test/plugin.test.ts` (`a subagent child cannot delegate again`)
  failed.

Restored both → both files green, and the full workspace suite passes.
