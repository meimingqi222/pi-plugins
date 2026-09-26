# pi-agent-runner

Shared subprocess agent runner for pi extensions that delegate work to a child
pi process.

This is a **library, not an extension**: it declares no `pi` manifest and
registers nothing. `pi-workflow` and `pi-subagent` depend on it in one direction,
so each remains independently installable.

## What it provides

| Export | Purpose |
|---|---|
| `resolvePiInvocation` / `jsonRunArgs` | resolve how to spawn pi from a source launch or a compiled binary, and the flags that make a run machine-readable |
| `createAgentExecutor` | spawn one pi child in JSON mode, fold its event stream, and bound it |
| `buildAgentArgs` | argv assembly, so flags and the `--` separator are asserted without spawning |
| `applyEvent` / `emptyStreamState` | the JSON-event folder, testable against recorded events |
| `agentChildEnv` / `SCHEDULER_DISABLE_FLAGS` | the one-level fan-out environment for a spawned agent |

## Why it is shared

`pi-workflow` and `pi-subagent` carried the same process handling twice. That
code has hung a real session (a piped stdin, an undrained stdout, a kill that
never fired), so a second copy is a second place to fix the same bug — and, as
happened, a divergence: the two copies disagreed about whether a non-zero child
exit is a failure, and about the timeout message.

## Design notes

**Policy stays in the plugins.** The runner spawns a child and reports what it
saw. It does not resolve tool roles, append a schema-repair block, decide what a
result means, or know which extensions a child should load. `pi-workflow` passes
its guard extension path and role-resolved tools; `pi-subagent` passes an agent's
own tool list and system prompt. The one exception is the fan-out environment,
which is a cross-plugin contract and so lives in one constant.

**`stdin` is `"ignore"`, never piped.** A piped stdin left open is a handle the
child can wait on forever, and the parent then waits on the child.

**A wall-clock timer terminates the process tree.** The call's `timeoutMs` wins
over the executor's default. POSIX children get their own process group; Windows
uses `taskkill /F /T`. After exit or cancellation, pipe draining is capped at
200ms so inherited handles cannot keep the result pending. POSIX cancellation
first sends SIGTERM to Pi, allowing it to clean up detached shell tools and
extensions; after a maximum 1000ms grace it escalates to SIGKILL. Cleanup is best
effort: descendants that escape the process group, or Windows descendants whose
parent has already exited, may need separate cleanup.

**stdout is drained continuously and stderr is bounded.** A reader that stops
consuming can stall pi once the pipe buffer fills, and a chatty child must not
grow the parent's heap.

**A non-zero exit is a failure.** The exit code is the last word, so a child that
writes nothing and fails is still reported as failed rather than as an empty
success.

**The one-level rule is a single constant.** A spawned process runs with
`PI_GOAL_DISABLE=1`, `PI_WORKFLOW_DISABLED=1` and `PI_SUBAGENT_DISABLE=1`, so it
neither resumes the user's goal, nor starts a workflow, nor delegates again.
Adding a fourth scheduler means editing `SCHEDULER_DISABLE_FLAGS`, not every
spawner.

Nothing here is a security boundary: a child is a full pi process with the
parent's permissions. The environment switches keep a delegation from silently
taking over the user's session; they are a contract, not a sandbox.

## Development

```sh
bun test
bun run typecheck
```

Spawn-path tests are driven by `test/fixtures/fake-pi.mjs`, which speaks pi's
JSON event stream, so process handling is checked without a provider or network.
