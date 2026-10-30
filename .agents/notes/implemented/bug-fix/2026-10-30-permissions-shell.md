# Agent Note: Permission classification covers compound redirects and credential paths

Status: implemented

## Problem

Compound shell statements lost redirects, clobber operators bypassed path checks, and nested credential searches and hard-link sources were not classified.

## Decision

Collect redirects on compound statements, treat clobber and read-write redirects as writes, check both ancestry directions for grep, and classify hard-link sources.

## Alternatives considered

Ignoring complex syntax lets read-only mode execute a write. Treating all links as source reads would also penalize symbolic links.

## Consequences

These ordinary shell forms remain guarded; this static policy is not a security boundary.

## Verification

- `plugins/permissions/test/security-boundaries.test.ts::compound redirects, clobber redirects, and nested credential searches fail closed`

Proved: the pre-fix assertion failed; output saved to `regression-evidence/permissions-compound-red.txt`.
