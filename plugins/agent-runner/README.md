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
| `DEFAULT_STALL_MS` / `resolveStallMs` / `describeAgentEvent` | the silence bound: its default, its precedence (`stallMs`, then `PI_AGENT_STALL_MS`, then the default), and the last-event label a stall report names. The sampling rule and both failure messages sit beside them in `src/executor.ts`, which `src/rpc-child.ts` imports rather than copies |

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
extensions; after a maximum 1000ms grace it escalates to SIGKILL. Both windows
are per-spawn overridable (`SpawnRpcChildOptions.terminationGraceMs` and
`stdioGraceMs`), because a test that drives a kill path against a child which
does not exit on SIGTERM waits the window out in full without observing it: the
RPC transport's unit tests shorten it, and `process-tree.test.ts` is what
measures the production values against real children. `process-tree.test.ts`
skips Windows — its cases are about process groups and inherited descriptors —
so `kill-tree.test.ts` is the one that kills a real child on either platform,
including the `taskkill` branch that a pid-less fake cannot observe. Cleanup is best
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
spawner. A separate `HEADLESS_CHILD_ENV` sets `PI_BG_BASH_THRESHOLD=0`: ambient
extensions load in the child, but a headless `-p`/rpc run has no session for
pi-bg-bash's auto-backgrounded job to wake, so the command would return a job
id whose result never arrives. `HEADLESS_CHILD_ENV` also sets `PI_AGENT_CHILD=1`
so approval extensions (pi-permissions) know prompts can never be answered in
this process and must deny instead of asking.

**A silent child is bounded twice.** The wall clock (`timeoutMs`, default 15
minutes) bounds the run — per *turn* on the RPC transport, where an idle lane
awaiting a reply spends none of it and each `agent_start` re-arms it; a silence
bound (`stallMs`, `PI_AGENT_STALL_MS`, default
5 minutes) fails it earlier and names the last event, because the deadline alone
diagnoses nothing. A tool call that declared its own `timeout` — pi's shell tools
take seconds, and `pi-workflow`'s child guard injects one — outranks the silence
bound for as long as it runs, so the command's own budget is the one that
reports. That budget is tracked per tool call, because pi runs a batch in
parallel and a short `read` finishing must not strip the exemption from the long
silent `bash` still in flight; a turn boundary drops whatever is left, so a call
that never reported an end cannot exempt the rest of a lane's life. Both
transports get the same sampling rule, the same messages and the same
composition, from `stallCheckIntervalMs`, `stallThresholdMs`,
`timeoutFailureMessage`, `stallFailureMessage` and `trackDeclaredTimeouts`.

**The first reason to end a run owns its label.** The deadline can expire inside
termination's grace period, so the wall clock must not overwrite what a stall or
a caller's abort already decided.

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
