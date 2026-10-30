# Agent Note: Bound the orphan window when a host dies without warning

Status: implemented

## Problem

`pi-agent-runner` spawns each child `detached: true` on POSIX so it leads its
own process group — which is what lets it outlive the terminal that launched it,
and equally what lets it outlive **the parent**. Nothing registered a
parent-exit hook, so when the host pi was `SIGKILL`ed (an OOM kill, a `kill -9`
in a script) every in-flight child survived as an orphan and kept running to
its own deadline: 15 minutes for a JSON child, 30 for a subagent lane, spending
provider budget with no owner left to read the result.

Reported by review as a follow-up; reproduced here by SIGKILLing a real parent
process and observing the child still alive afterwards.

## Decision

A **watchdog process** per run: a second, tiny process whose only job is to
notice the parent is gone and take the child's process group with it
(`parent-watchdog.ts`).

- It is spawned `detached: true` as well, so the parent's death does not take it
  down before it can act.
- It polls `process.kill(parentPid, 0)`, which throws `ESRCH` once the parent is
  gone. A poll rather than a pipe: a pipe closes on *any* parent exit, including
  a clean one the child should survive.
- It kills the child's whole **group**, not just the child, so a grandchild the
  child spawned does not outlive it.
- It exits when the child exits on its own, and hard-stops at a lifetime cap, so
  a wedged watchdog cannot linger.
- Windows is a no-op: no process groups and no `kill(pid, 0)` liveness probe, so
  the group sweep there stays the runner's existing `taskkill` path.

The runner starts it immediately after `spawn` and stops it in `finish()`, so a
burst of short agents does not leave a trail of one-second processes.

**The watchdog's interval is deliberately not `unref`d.** This was the bug the
first version shipped: the pattern was copied from `executor.ts`, where unref'ing
is correct because the executor has other work pending. A watchdog has nothing
else to do, so an unref'd interval let the event loop empty and the process exit
*before* the parent it was meant to outlive — silently restoring the original
failure. Its exit is bounded by the three conditions above instead.

## Alternatives considered

- **`PR_SET_PDEATHSIG`.** The right primitive, and unavailable: Node exposes no
  portable binding, and this runner also supports Windows where the signal does
  not exist.
- **Parent-death pipe.** Rejected: it fires on a clean parent exit too, which
  would kill children the parent deliberately left running.
- **Poll from the parent.** Cannot work — the parent is the thing that died.
- **Document the window and do nothing.** Rejected: the window is fifteen to
  thirty minutes of real spend, and the watchdog is cheap.

## Consequences

- **The watchdog runs with a minimal environment.** It reads two pids and
  signals one group, so it has no business holding a copy of the parent's
  environment — which on a host running this plugin is every provider key the
  session carries. Omitting `env` would inherit all of it by default, so the set
  is stated: `PATH`, plus the four values the program reads.



- One extra short-lived process per agent run. It is `stdio: "ignore"`, sleeps
  in a one-second interval, and is stopped as soon as the run settles.
- Still best effort: `SIGKILL` the watchdog as well and the orphan window
  returns. That is now stated in the module header rather than implied to be
  solved.
- `AgentExecutorOptions` gained an optional `watchdog` field for poll and
  lifetime tuning; omitted, the defaults apply and nothing changes for callers.

## Verification

- `plugins/agent-runner/test/parent-watchdog.test.ts` — `the watchdog is given a
  minimal environment, not the parent's` plants a marker in the parent's
  environment and asserts it does not reach the child, alongside `the child dies
  when its parent is SIGKILLed` drives a real parent process that arms the watchdog and
  then `process.kill(process.pid, "SIGKILL")`s itself, and asserts the victim is
  alive the instant the parent dies and dead shortly after. Plus the no-pid,
  Windows, idempotent-stop, grandchild-group and lifetime-cap cases.
- Red-run proof: the first version of the watchdog passed every test except the
  SIGKILL one, which reported the victim still alive — the unref'd interval. The
  fix is the removal of that one call.

Proved: Proved: the first version of `parent-watchdog.ts` kept the `timer.unref()` copied from `executor.ts`; `plugins/agent-runner/test/parent-watchdog.test.ts::the child dies when its parent is SIGKILLed` then failed with the victim still alive 800 ms after the parent's death, because the unref'd interval let the watchdog's event loop empty before the parent died. Removing that one call is the fix.
\n\nProved: `regression-evidence/watchdog-env-red.txt` — restoring `...process.env` in the spawn options makes the minimal-environment test fail with the planted marker arriving in the child (`Received: "do-not-propagate"`).\n