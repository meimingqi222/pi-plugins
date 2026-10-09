# Agent Note: Await bounded Windows tree cleanup

Status: implemented

## Problem

taskkill was unreferenced without waiting before agent settlement.

## Decision

Return a cleanup promise, memoize it in both transports, await delivery cleanup and bound taskkill at two seconds.

## Alternatives considered

Unbounded waits hang cancellation; immediate return exposes settlement before cleanup.

## Consequences

POSIX signals immediately. Injected Windows helper completion/timeout tests pass; native Windows execution remains unverified here.

## Verification

- Test file: `plugins/agent-runner/test/windows-kill.test.ts`

- `plugins/agent-runner/test/windows-kill.test.ts::Windows cleanup awaits taskkill completion`

Proved: Both completion and stuck-helper tests failed before the change and pass after it.
