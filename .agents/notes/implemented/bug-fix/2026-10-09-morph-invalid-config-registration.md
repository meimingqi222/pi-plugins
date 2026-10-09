# Agent Note: Keep tools visible after config errors

Status: implemented

## Problem

Invalid numeric config threw before tool registration.

## Decision

Retain the validation error, register tools, report startup/execution errors, and disable optional compaction for invalid config.

## Alternatives considered

Silent defaults hide the error; registration throws hide the tools.

## Consequences

Tools remain discoverable and report the original validation error on execution.

## Verification

- Test file: `plugins/morph-search/test/plugin.test.ts`

- `plugins/morph-search/test/plugin.test.ts::invalid config keeps search tools registered for a diagnosable execution error`

Proved: Registration originally threw and failed; afterward both search tools are registered.
