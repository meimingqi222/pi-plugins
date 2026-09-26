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

## Alternatives considered

Killing only the child leaves descendants alive. Waiting exclusively for close
has no upper bound. Resolving immediately on exit can discard buffered events.
Importing pi-bg-bash would make the shared runner depend on an optional plugin.

## Consequences

Workflow and subagent share the corrected lifecycle. Cleanup remains best effort:
descendants escaping the group and Windows descendants whose parent already
exited cannot be guaranteed to terminate. Bounded pipe draining still applies.
Windows taskkill behavior requires platform verification; local process tests
exercise POSIX groups and inherited descriptors.

Pi's normal bash and bg-bash create separate process groups, so the graceful
phase is necessary, not merely cosmetic. If Pi's handler itself hangs before
cleaning an escaped group, force-killing the parent cannot guarantee cleanup
of that group. No platform-independent process sandbox is claimed.

## Verification

- `plugins/agent-runner/test/process-tree.test.ts`
- `plugins/agent-runner/test/process-tree.test.ts::inherited pipes cannot delay`
- `plugins/agent-runner/test/process-tree.test.ts::stops writing after agent`

Proved: before the fix all three new cases (timeout, abort, exit) took about
4 seconds and failed the 2500ms bound. After the fix they pass in about 622ms,
607ms and 267ms, and independently check that the descendant PID is gone.

Proved: the follow-up real Pi print-mode + built-in bash tests failed before
graceful termination: the heartbeat file grew after both abort and timeout
returned. With SIGTERM-before-SIGKILL they stop writing. The same checks also
exercise the real bg-bash extension's shutdown handler, and an ignored-SIGTERM
fixture verifies escalation. These tests execute local commands, not model calls.
