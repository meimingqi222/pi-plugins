# Agent Note: Check all grep-family credential searches

Status: implemented
Partly-superseded-by: 2026-10-09-permissions-yolo-auto-allow.md

## Problem

Only grep checked broad credential search roots.

Dropping options and then unconditionally skipping the first operand also hid
the first file with `--regexp=needle` (read-only allowed a credential read).

## Decision

Use normalized executable names and apply the credential-root policy to grep, rg, egrep and fgrep.

Extract search operands separately: explicit `-e`/`--regexp` or `-f`/`--file`
means all positional operands are paths; pattern files are themselves reads.
Handle attached/separate values, short clusters, repeated expressions and `--`.
Respect grep versus rg short-option arities and grep's optional color value.
Unknown options and dynamic/missing values remain unresolved, not safe.

## Alternatives considered

Raw executable matching misses absolute paths; treating all searches as dangerous blocks workspace search.

Keeping the generic option filter cannot distinguish a pattern from a path.
Treating every argument as a path would falsely flag patterns naming credential
locations; guessing unknown option arity could silently hide a real file.

## Consequences

Credential roots ask in ask/auto; workspace searches remain allowed. YOLO's
decision behavior follows the successor note below.

In guarded modes, expression-option credential reads cannot bypass path policy;
read-only denies them. Unrecognized search syntax may require confirmation even
when a particular executable would accept it. This is not a complete CLI parser.

## Verification

- Test file: `plugins/permissions/test/security-boundaries.test.ts`

- `plugins/permissions/test/security-boundaries.test.ts::all grep-family tools ask before searching credential roots`

Proved: The old rg result was safe/allow and the family test failed; all variants pass after the change.

- `plugins/permissions/test/security-boundaries.test.ts::grep expression options never hide protected path operands`

Proved: Before implementation, `bun test plugins/permissions/test/security-boundaries.test.ts -t 'grep expression options'`
failed at the read-only decision assertion (expected deny, received allow; the
plain-pattern control passed first). Actual output is saved in
`.agents/notes-evidence/2026-10-19-permissions-regexp-operands-red.txt`.
The same test passes after the option-aware extraction fix, including workspace
controls, pattern-file reads, dynamic/missing arguments and option boundaries.


## Superseded

The classifier/path-boundary decision still holds. The universal dangerous
confirmation requirement, including claims that yolo asks or headless yolo
denies dangerous calls, is replaced by the successor: YOLO allows dangerous
classifications unless an explicit user rule restricts the call. Ask/auto
retain guarded confirmation and forbidden operations remain denied.
