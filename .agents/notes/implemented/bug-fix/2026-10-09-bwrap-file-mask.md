# Agent Note: Mask files with file bind mounts

Status: implemented

## Problem

--tmpfs was used for protected regular files as well as directories.

## Decision

Inspect path type: tmpfs for directories, read-only /dev/null bind for files.

## Alternatives considered

tmpfs is a directory filesystem; omitting masks permits credential reads.

## Consequences

Generated argv distinguishes file and directory mounts. Native Linux execution remains unverified on macOS.

## Verification

- Test file: `plugins/permissions/test/sandbox.test.ts`

- `plugins/permissions/test/sandbox.test.ts::bwrap masks credential files with a file rather than tmpfs`

Proved: The file test originally saw tmpfs and failed; afterward it sees ro-bind /dev/null and directory masking still passes.
