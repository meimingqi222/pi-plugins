# Agent Note: One child I/O implementation for both transports

Status: implemented

## Problem

`rpc-child.ts` duplicated `executor.ts`: a `writeSystemPromptFile` marked
"Copied from executor.ts", its own stdout line-splitting/JSON-parse loop, its
own `finish()` outcome mapping, its own `MAX_*` constants, and its own
evidence writer. They had drifted where it matters: executor's evidence used
a `0o700` directory and `0o600` appends with a marker kept inside the byte
cap, while rpc-child used default permissions — for a log that holds prompts
and tool data — and a different truncation (`bytes` field, written past the
cap). Two copies of subtle process handling is exactly what this package
exists to prevent; its README records what the last drift cost.

## Decision

**One module, `src/child-io.ts`, holds the shared I/O:**

- `writeSystemPromptFile(systemPrompt, root?, prefix)` — the private temp
  prompt file, same error text; the transports differ only in the mkdtemp
  prefix.
- `createEvidenceWriter({ path?, maxBytes? })` → `{ write, flush }` —
  executor's semantics for both: `mkdir(dirname)` at `0o700`, every append at
  `0o600`, and `{"type":"evidence_truncated","maxBytes":N}` written only when
  it still fits inside the cap. The RPC transport keeps its own default cap
  (512KB) when the caller passes none.
- `createJsonLineReader(onLine)` — the LF-split reader (no `readline`:
  Unicode separators inside JSON strings are not record boundaries) with the
  shared `MAX_BUFFER_CHARS` cap, CR stripping, and one callback per raw line
  plus the parsed event or `undefined`.
- `mapRunOutcome(...)` — the killedBy/errorMessage/stderr/exitCode →
  `AgentRunResult` mapping. `parse` is a parameter because only the JSON
  transport offers structured values; an RPC caller gets text.
- `MAX_STDERR_CHARS`/`MAX_BUFFER_CHARS` live there so neither transport can
  quietly re-bound the other's stream.

Public exports from `index.ts` are unchanged; `child-io.ts` is
package-internal.

## Alternatives considered

- **Leave the duplication and fix the permissions only.** Repairs today's
  symptom and guarantees the next drift; the package's whole reason for
  existing is that these copies diverge.
- **Subclass/share the whole transport.** The transports differ in real ways
  (piped stdin, turn lifecycle, command acks, dialog answers); a shared base
  would couple the differences, not just the sameness.
- **Fold the reader's parse into the callback's contract** (only fire on
  JSON). Rejected: the evidence sink wants non-JSON diagnostics lines too, so
  the callback sees every raw line.

## Consequences

The RPC evidence log is now owner-only (`0o600` file, `0o700` dir) and its
truncation marker is `evidence_truncated` with `maxBytes`, kept inside the
cap — previously it could exceed the cap by one line plus marker. No other
behavior change is intended.

## Verification

- `plugins/agent-runner/test/rpc-child.test.ts` — "the evidence log is
  written private: directory 0o700, file 0o600" (skipped on win32).
- The rest of the file plus `executor.test.ts` pin the refactor as
  behavior-preserving.

Proved: before the refactor, the new permissions test failed — the RPC
evidence file was created with default umask permissions (`1 fail`). After
the refactor, `bun test plugins/agent-runner` reports 77 pass, 0 fail.
