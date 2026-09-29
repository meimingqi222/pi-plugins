# Agent Note: Bound agent settlement independently of inherited pipes

Status: implemented

## Problem

The executor killed only the immediate child and waited for close. A descendant
inheriting stdout or stderr prevented close after timeout, abort, or normal
parent exit. The wall-clock timeout therefore did not bound the tool call.

## Decision

Spawn a dedicated POSIX process group and kill that group during cleanup.
Windows uses the trusted System32 taskkill with /F /T. Drain pipes for at most
200ms after exit or cancellation, then destroy the streams and settle, retaining
the usage and events already received. Clear the execution timeout on exit so
draining cannot relabel a finished process as timed out.

On POSIX timeout or abort, first send SIGTERM to the Pi child, allowing its
print-mode handler to kill tracked detached shells and shut down extensions.
After at most 1000ms force-kill the executor group, then bound draining as above.
Normal exit still performs group cleanup. An uncooperative child cannot extend
the grace period by ignoring SIGTERM.

The stop a caller observes is therefore platform-shaped, and the rpc-child
test assertions state it that way: POSIX reaches the fake through
`child.kill("SIGTERM")`, while Windows goes straight to the tree kill on the
child's pid and signals through no ChildProcess method at all, so a fake with no
pid — which that file's fakes have on purpose, since a fixed fake id can name a
real process group — observes nothing.

The Windows branch is now covered by a real child instead:
`test/kill-tree.test.ts` spawns a live process, calls `killAgentTree` on its pid,
and requires the pid to be gone. That is the platform verification this note used
to list as outstanding.

## Alternatives considered

Killing only the child leaves descendants alive. Waiting exclusively for close
has no upper bound. Resolving immediately on exit can discard buffered events.
Importing pi-bg-bash would make the shared runner depend on an optional plugin.

## Consequences

Workflow and subagent share the corrected lifecycle. Cleanup remains best effort:
descendants escaping the group and Windows descendants whose parent already
exited cannot be guaranteed to terminate. Bounded pipe draining still applies.
Windows taskkill behavior is verified on Windows by `test/kill-tree.test.ts`;
`test/process-tree.test.ts` stays POSIX-only because its scenarios are about
process groups and inherited descriptors, not about the stop itself.

Pi's normal bash and bg-bash create separate process groups, so the graceful
phase is necessary, not merely cosmetic. If Pi's handler itself hangs before
cleaning an escaped group, force-killing the parent cannot guarantee cleanup
of that group. No platform-independent process sandbox is claimed.

## Verification

- `plugins/agent-runner/test/process-tree.test.ts`
- `plugins/agent-runner/test/process-tree.test.ts::inherited pipes cannot delay`
- `plugins/agent-runner/test/process-tree.test.ts::stops writing after agent`
- `plugins/agent-runner/test/kill-tree.test.ts::ends a real child process on this platform` — the Windows taskkill branch, on a live process; POSIX takes the group kill through the same entry point.

Proved: before the fix all three new cases (timeout, abort, exit) took about
4 seconds and failed the 2500ms bound. After the fix they pass in about 622ms,
607ms and 267ms, and independently check that the descendant PID is gone.

Proved: the follow-up real Pi print-mode + built-in bash tests failed before
graceful termination: the heartbeat file grew after both abort and timeout
returned. With SIGTERM-before-SIGKILL they stop writing. The same checks also
exercise the real bg-bash extension's shutdown handler, and an ignored-SIGTERM
fixture verifies escalation. These tests execute local commands, not model calls.

Proved: stubbing the Windows branch of `killAgentTree` (`if (process.platform ===
"win32") return;`) failed `ends a real child process on this platform` with
`Expected: false, Received: true` after its 5s poll — the spawned process was
still alive; with the branch restored it passes in 272ms. The two rpc-child
assertions that used to demand SIGTERM also failed on Windows before
`expectChildKilled` stated the platform contract.
