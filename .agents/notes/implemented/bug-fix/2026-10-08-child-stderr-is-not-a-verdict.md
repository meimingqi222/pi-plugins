# Agent Note: A child's stderr is diagnostics, not a verdict

Status: implemented

## Problem

`mapRunOutcome(...)` promoted any non-empty child stderr into
`state.errorMessage`, and a set `errorMessage` returns
`{ status: "failed" }`. Ambient extensions load in a child, so a startup
warning on stderr is routine rather than exceptional. The result: a child that
produced a real answer and exited 0 was reported as failed, the answer was
discarded, and the warning text was shown to the user as the error.

Found by spawning a single `explore` subagent, which failed twice in a row with
`Agent "explore" failed: Warning: Extension package "…/@parallel-web/pi-extension/package.json":
Host-provided extension packages must be declared in peerDependencies…`. That
package is npm-installed at `~/.pi/agent/npm` and declares `typebox` — a
host-provided module — under `dependencies`, so every child printed the warning
at startup. The warning itself is the package's bug; treating it as the run's
verdict is ours, and it makes *every* delegated run fail for anyone with such an
extension installed. The runner's own README already stated the contract as
"A non-zero exit is a failure. The exit code is the last word."

## Decision

Stderr becomes `errorMessage` only where nothing else can carry the verdict:
when the child exited non-zero, or when it exited 0 without reply text. A run
that replied and exited 0 completes, whatever it wrote to stderr. The generic
`The agent exited with code N.` message is unchanged and still follows, so a
non-zero exit with no stderr keeps its diagnostic.

The two diagnostics that matter are preserved: a child that fails silently and
writes only to stderr still reports stderr, and a crash that left a partial
reply still reports stderr rather than the less specific exit code.

## Alternatives considered

- **Silence the source: patch the installed npm package's `package.json` to
  declare `typebox` in `peerDependencies`.** Removes this trigger, fixes no
  other, and is reverted by the next `npm install` — the runner would still
  fail every child of any chatty extension.
- **Treat stderr as a warning attached to a successful result.** The runner's
  `AgentRunResult` has no non-fatal diagnostic channel, so this would need a
  contract change on both transports and every caller, for a message the user
  cannot act on.
- **Report the run as completed but keep stderr in `errorMessage`.** A
  `completed` result carrying `errorMessage` contradicts the shape callers read
  (`errorMessage` is the failure text), and the status is what gates delivery.
- **Fail only on stderr that matches warning-shaped lines.** Guessing at text
  shape inverts the contract: it would keep a genuine crash whose message does
  not start with `Warning:` from failing the run.

Reported upstream as a packaging bug in the extension; no Paseo or pi change is
needed for this fix.

## Consequences

A delegated run's status now follows its exit code and its reply, not the
chatter on its stderr. Benign startup warnings no longer replace an answer with
an error, and the same holds for the JSON transport, which shares this mapping.

Stderr text is dropped when a run replied and exited 0. That text was previously
the error message, so it was never visible as diagnostics in the success path
either; a child that wants its stderr seen must fail. Nothing else about the
outcome mapping changes: aborts stay aborts, and the timeout/stall messages keep
their precedence over both stderr and the exit code.

## Verification

- `plugins/agent-runner/test/stderr-verdict.test.ts` — the new case pins a
  warning on stderr plus a reply plus exit 0 as `completed` with the answer
  intact and no `errorMessage`; three more cases pin what must not change
  (stderr explains an exit-0 child with no reply, stderr explains a non-zero
  exit that left a partial reply, and an abort stays an abort).
- `plugins/agent-runner/test/deadline-diagnostic.test.ts` and
  `plugins/agent-runner/test/rpc-child.test.ts` pin the timeout/stall/stream
  error precedence this change must not disturb.

Proved: before the fix, `bun test plugins/agent-runner/test/stderr-verdict.test.ts`
reported `1 fail` — the new success case received `failed` instead of
`completed`, while the other four cases already passed. After the fix, the same
file reports `5 pass, 0 fail`, and `bun run --filter pi-agent-runner test`
reports `92 pass, 0 fail`.
