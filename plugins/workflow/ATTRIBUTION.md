# Attribution

`pi-workflow`'s pure-logic core is ported from the Step Workflow runtime in
[`stepfun-ai/Step-Code`](https://github.com/stepfun-ai/Step-Code), MIT licensed.

| File here | Origin in Step-Code |
| --- | --- |
| `src/core/types.ts` | `packages/coding-agent/src/features/workflow/types.ts` |
| `src/core/schema.ts` | `packages/coding-agent/src/features/workflow/schema.ts` |
| `src/core/hash.ts` | `stableJson`/`workflowHash`/`workflowJsonValue` in `.../workflow/journal.ts` |
| `src/core/journal.ts` | the resume rule in `.../workflow/journal.ts` (`WorkflowJournal.getCached`) |
| `src/runs/journal.ts` | the file layout and append queue in `.../workflow/journal.ts` |

Why vendored rather than depended on: Step-Code is a full product repository, not
a published library, and its workflow core is wired to `@step-harness/*` packages
and a `.stepcode/` storage root. A pi extension has to be installable from one
directory and has to use pi's conventions.

## Deliberate divergence from upstream

| Behaviour | Step-Code | Here | Reason |
| --- | --- | --- | --- |
| Storage root | `.stepcode/workflows` | `.pi/workflows` | This is a pi plugin; the directory belongs to pi. |
| Resume state | a `resumeEnabled` boolean and a `Map` inside `WorkflowJournal` | a pure `ResumeLog` object in `core/`, no file I/O | The prefix-only rule is the subtle part and must be testable without a filesystem. |
| Journal read | `readJsonLines` returns every parseable line | `WorkflowJournal.load` also truncates at the first sequence gap | A contiguous prefix is the only safe replay source; upstream relied on the caller's hash checks alone. |
| Isolation seam | `runInIsolatedVm` with the `isolated-vm` native addon | a `node:worker_threads` worker (`host/bridge.ts`) | `isolated-vm` cannot load in pi's `bun --compile` binary. A worker gives the property that matters — `terminate()` kills a synchronous infinite loop — on both Node and Bun, without a native addon or a second interpreter. |
| HoH `iterate()` | present | not ported | Overlaps `pi-goal`'s verifier; deferred deliberately. With role profiles in place the loop is expressible as `agent()` calls in a script. |
| Tool isolation | `tool-profile.ts` + an `acl-extension` intercepting `tool_call` in the child | `runner/roles.ts` resolves a role to a tool list passed as `--tools` to the child pi | pi enforces the list itself, so no child-side interception extension is needed. Path-level mounts were cut: write permission is a role property. The `readOnly`/`writable` option fields that outlived that cut were removed — they were never read. |
| Run lifecycle | blocking tool call with `onUpdate` progress | `runs/registry.ts`: launched in the background, result delivered as a `workflow-result` message | A workflow outlives the turn that asked for it; a blocking call would hold the conversation hostage. |
| `WorkflowMeta.roleSchemas` | present but only advisory | **removed** | Nothing read it in either codebase's port here, so it advertised a check that never ran. A declaration nobody consumes is worse than no declaration: it reads as a guarantee. |

Changed names: `WorkflowRunPaths`/`createWorkflowRunPaths` are unchanged;
`resolveStepWorkflowRoot` was dropped in favour of `resolveWorkflowRoot`.

The `schema.ts` validator is unchanged except for comments: it is the same
TypeBox `Check`/`Errors` path with the same `stripUnknown` behaviour, because the
semantics there are load-bearing for the agent retry loop.
