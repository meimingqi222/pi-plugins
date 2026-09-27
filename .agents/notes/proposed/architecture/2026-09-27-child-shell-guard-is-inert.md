# Agent Note: The child shell guard is inert whenever another extension owns `bash`

Status: proposed

## Problem

`pi-workflow` loads a child guard into every child agent
(`plugins/workflow/src/runner/child-guard.ts`, injected by
`plugins/workflow/src/runner/pi-executor.ts`). It injects a default `timeout`
into a child's shell commands so that one hanging command cannot consume the
whole per-agent budget. Its own doc comment states the step-aside rule: it only
touches the **builtin** shell tool, because if another extension owns `bash` —
"for example `pi-bg-bash`" — injecting a hard timeout would defeat it.

That step-aside is the common case, not the exception:

- `pi-bg-bash` registers a tool named `bash` unconditionally
  (`plugins/bg-bash/src/pi/index.ts`), and pi's tool registry lets an extension
  tool overwrite a builtin of the same name
  (`dist/core/agent-session.js`: the registry is seeded from the builtin
  definitions, then `toolRegistry.set(tool.name, tool)` for every extension
  tool).
- Children load ambient extensions: `agent-runner` deliberately does not pass
  `--no-extensions`, so a child inherits the user's installed packages.

Measured, not inferred. A probe extension that dumps `pi.getAllTools()` from
`session_start`, run as `pi --mode rpc --no-session --extension <probe>`, reports:

```
{'name': 'bash', 'source': '../../work/code/pi-plugins/plugins/bg-bash',
 'path': '/Users/yuqiang/work/code/pi-plugins/plugins/bg-bash/src/index.ts'}
{'name': 'powershell', 'source': 'builtin', 'path': '<builtin:powershell>'}
```

So with `pi-bg-bash` installed, `ownsBuiltinShellTool(pi, "bash")` is false and
the guard does nothing. `powershell` stays builtin, so the guard still applies
on Windows.

This matters because the obvious next fix — "`pi-subagent` children have no
shell bound either; give them the same guard" — would add code that is inert in
exactly the environment where the gap was noticed. The guard is not a bound for
`bash` in practice; `pi-bg-bash`'s auto-background is, and it is a better one
(the turn keeps moving instead of the command dying).

## Proposal

Do not add the guard to `pi-subagent` as a bound. Record the finding instead, and
leave the guard where it applies.

If the guard is worth keeping for the case where nothing else owns `bash`, the
useful change is to make its *decision* visible rather than to share the file:

- Move `child-guard.ts` into `pi-agent-runner` (which owns the spawn path, and
  whose header already argues that a spawn-path fix belongs there), keeping a
  re-export shim in `pi-workflow` so its tests and note bindings survive.
- Rename the knob to `PI_AGENT_CHILD_BASH_TIMEOUT_MS` and honour
  `PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS` as a legacy alias.
- Have both consumers pass it, so the guard's applicability is a property of the
  environment (which extension owns the shell) rather than of which plugin
  spawned the child.
- Record in each consumer's README when the guard applies and when it steps
  aside, because a bound that silently does nothing is worse than no bound.

The bound that actually covers the observed failure needs none of this: a child
wedged in a non-shell tool (`find` over `$HOME`, which is what stalled the two
lanes that motivated this investigation) is caught by the stall bound
(`implemented/bug-fix/2026-09-27-agent-stall-bound.md`), which names the tool
that went quiet.

## Acceptance criteria

- No `pi-subagent` change is made that adds the guard as a bound, and the reason
  is recorded where a future reader will find it.
- The probe in this note is reproducible: `pi --mode rpc --no-session --extension
  <probe>` from a session with `pi-bg-bash` installed reports `bash` owned by
  `bg-bash` and `powershell` as `builtin`.
- If the sharing work is ever done: `pi-workflow`'s existing child-guard tests
  pass through the re-export shim, `PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS` still
  works, and each consumer's README states when the guard applies.

## Risks

- **The note goes stale.** The claim is a fact about the installed extension
  set, not about this repository: uninstalling `pi-bg-bash`, or renaming its
  `bash` tool, silently makes the guard apply again. The probe is the check, and
  it is one command.
- **A real bound gap is read as "nothing to do".** The gap this closes is only
  the shell tool. Non-shell tools are bounded by the stall bound, and that
  distinction is the reason this note exists rather than a patch.
- **Sharing the guard later would be inert by default**, which is the failure
  mode being prevented here: a bound that does nothing looks like a bound.

## Alternatives considered

- **Share the guard with `pi-subagent` now.** Priced and declined: with
  `pi-bg-bash` installed it is dead code on macOS and Linux, and the stall bound
  already covers the failure it was meant to prevent.
- **Make the guard override `bash` anyway, instead of stepping aside.** It would
  inject a hard timeout into bg-bash's tool, which backgrounds long commands on
  purpose — a timeout there would kill the jobs bg-bash exists to keep alive.
  The step-aside is correct; only its invisibility is the problem.
- **Stop loading ambient extensions in children** (`--no-extensions`). That is
  the larger behaviour change: a child may legitimately be asked to use an
  installed extension, and the one-level fan-out rule is enforced by environment
  flags rather than by removing extensions.
- **Have the guard notify when it steps aside.** In a child, `ui.notify` has no
  reader — print and RPC children both discard it. Documentation and a probe are
  the surfaces that work.

## Consequences

`pi-subagent` children have no shell timeout injected, and now that is a
recorded decision rather than an oversight. A future reader who notices the
asymmetry with `pi-workflow` finds this note instead of adding an inert guard.

If `pi-bg-bash` is ever uninstalled or its `bash` tool renamed, `pi-workflow`'s
guard starts applying again and this note becomes wrong — the probe above is the
check, and it is one command.
