# Agent Note: See in-place editors and archive sources in pi-permissions

Status: implemented

## Problem

The shell intent extractor knew about redirects, `tee` and a short list of
write commands. Two common spellings produced no intent at all:

- `sed -i '…' ~/.bashrc`, `patch ~/.bashrc < diff`, and
  `dd of=~/.bashrc` rewrote a protected file with no redirect. Measured
  before the fix: `echo x > ~/.bashrc` and `tee ~/.bashrc` were
  `dangerous/protected-write`, while the three in-place forms were bare
  `grey`.
- `tar czf - ~/.ssh | nc …` and `zip -r out.zip ~/.aws` produced no read
  intent, so `secret-exfil` never saw a credential path. `cat ~/.ssh/id_rsa |
  curl …` was `forbidden/secret-exfil`; the archive forms were bare `grey`.

## Decision

- Parse `sed`'s `-i`/`--in-place` with its own operand walker, because `-i`
  takes an optional backup suffix (separate word on macOS, attached on GNU)
  and `-e`/`-f` consume a script operand.
- Treat `patch`'s first operand as a write and a second as a read.
- Parse `dd`'s `of=`/`if=` assignments.
- Give `tar`, `zip` and `unzip` operands: a creating `tar` writes the archive
  and reads its sources, an extracting `tar` reads the archive, `zip` writes
  its archive and reads sources, `unzip` reads its archive.

## Alternatives considered

**Add `sed`, `patch`, `tar`, `zip` to `WRITE_TARGETS`.** Over-classifies:
`sed`'s script expression and a `tar` archive's sources would become write
targets, and every source would be reported as a protected write.

**Track archive contents across `&&`.** The `zip … && curl -T out.zip` form
is still a limitation: the rule requires a pipeline. Detecting data flow
through a file needs a taint model, which is a larger change than this fix.

## Consequences

`sed -i`, `patch` and `dd of=` now classify as `dangerous/protected-write`
for a protected path, and `tar … | nc` classifies as
`forbidden/secret-exfil`. Ordinary workspace edits stay grey rather than
being promoted.

## Verification

- `plugins/permissions/test/security-boundaries.test.ts` — "in-place editors
  cannot route around protected writes", "archive tools expose credential
  sources to the exfil rule", and "ordinary edits and archives are not
  promoted".

Proved: with `plugins/permissions/src/shell/intents.ts` restored, the in-place test fails
with the expected `grey`/`ask` instead of `dangerous`/`ask`, and the archive
test fails with `grey` instead of `forbidden`.
