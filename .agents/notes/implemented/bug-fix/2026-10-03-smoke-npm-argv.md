# Agent Note: Preserve npm arguments on Windows

Status: implemented

## Problem

The smoke install's shell execution split paths containing spaces and interpreted
shell metacharacters. Windows temp paths can contain spaces, so smoke failed
before loading packed extensions.

## Decision

On Windows locate npm's JavaScript CLI beside its PATH installation and execute
it with the current runtime, passing an argument array without a shell. Keep
direct npm execution on other platforms. The smoke script uses this helper.

## Alternatives considered

Shell quoting would require platform-specific escaping and remain sensitive to
metacharacters. Switching to bun install would change what smoke verifies.

## Consequences

Spaces and ampersands remain literal argv content. Windows needs the standard
npm distribution layout, node_modules/npm/bin/npm-cli.js, on PATH or beside
the runtime. No package installation or network is needed for the regression.

## Verification

- `plugins/run-core/test/npm-command.test.ts`
- `plugins/run-core/test/npm-command.test.ts::npm invocation preserves spaces and shell metacharacters`

Proved: the shell implementation split the installed folder path and attempted
to execute b.tgz as a command; after direct CLI execution the fake npm receives
the exact original argument array.
