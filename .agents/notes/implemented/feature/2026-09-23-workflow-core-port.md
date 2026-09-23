# Agent Note: Port the workflow core with a testable resume rule

Status: implemented

## Problem

Stage 1 of `pi-workflow` needed the pure-logic core: JSON contracts, schema
validation, stable hashing, and the resume rule. Step-Code has all of it, but its
implementation is not usable as-is: the resume rule lives *inside*
`WorkflowJournal`, which also owns file layout, an append queue, and telemetry
files, so the rule that decides whether resumed work may be reused cannot be
tested without a filesystem.

That matters because the rule is where the interesting failure is. A resumed run
must reuse the journaled prefix and execute live from the first divergence. The
obvious implementation — look up a result by call hash, keep searching — is
wrong in a way that is worse than having no cache: it returns cached results for
calls *after* the divergence, silently mixing a previous execution into the new
one.

## Decision

Split the port by purity rather than by source file.

- `core/journal.ts` holds `ResumeLog`, the prefix-only rule, with no I/O. It is
  constructed from a previous run's entries and answers `cached(seq, hash)`.
- `runs/journal.ts` holds the storage layout, atomic writes, and the append
  queue, and delegates every reuse decision to `ResumeLog`.

Four divergences from upstream, each with a reason recorded in
`ATTRIBUTION.md`:

- **Storage root is `.pi/workflows`**, not `.stepcode/workflows`.
- **Resume is one-way.** `cached` disables resume permanently on the first
  mismatch or non-reusable entry; it never re-enables. Upstream relied on the
  caller's hash checks alone.
- **`WorkflowJournal.load` truncates at a sequence gap.** Upstream's
  `readJsonLines` returns every parseable line, so a hole in the sequence was
  invisible. A contiguity check is what makes "prefix" mean prefix.
- **Keying is by `seq`, not by hash.** Two identical prompts at different points
  in a script are two calls; a hash-keyed cache would collapse them into one.

`isolated-vm`, the HoH `iterate()` loop, and Step-Code's compiler (typecheck,
taint analysis, causality graphs, mermaid output) are **not** ported. The addon
cannot load in pi's `bun --compile` binary; `iterate()` overlaps `pi-goal`'s
verifier; the compiler is ~20k lines serving a use case that runtime schema
validation already covers at the cost of one agent call.

## Alternatives considered

**Keep `WorkflowJournal` whole and port it verbatim.** Fastest, but leaves the
resume rule untestable without touching a filesystem, and carries upstream's
hash-lookup shape that the prefix rule exists to prevent.

**Port the compiler's early validation.** The valuable part of Step-Code's
compile-time discipline is catching a bad schema before paying for an agent call.
A subset of that is available for free: `meta.roleSchemas` lets a script declare
a role's output shape up front, and `validateWorkflowSchema` can check it before
the first call. The rest — a TypeScript checker, taint fixpoint, causality
graphs — is not worth its size here.

**Put the run journal in `.pi/` but keep Step-Code's file names.** Kept the
names (`journal.jsonl`, `progress.json`, …) since they are descriptive; changed
only the root.

## Consequences

`pi-workflow` has no `pi` manifest and registers nothing, so pi will not load it
as an extension yet. That is deliberate: a package that declares an extension
entry point it does not implement would fail at load. The manifest arrives with
the tool in stage 4.

`core/` is now pure, which is what lets stage 2's sandbox host be tested as a
host without dragging in the journal.

## Verification

- `plugins/workflow/test/core.test.ts` — hashing, `ResumeLog`, entry validation, usage math
- `plugins/workflow/test/schema.test.ts` — validation, `stripUnknown`, TypeBox `safeParse`
- `plugins/workflow/test/journal.test.ts` — disk layout, atomic script write, prefix resume, truncation, concurrent appends

`38 pass, 0 fail` across the three files.

Proved each kill-surface by sabotage, so no single assertion carries the claim:

- **A hash-keyed lookup that keeps searching past a divergence** (the exact
  upstream shape the split exists to avoid) replaced `cached`. It failed exactly
  `ResumeLog > a mismatch disables resume for every later call`.
- **Returning a plain object instead of a null-prototype record** in
  `workflowJsonValue`. It failed exactly
  `workflowJsonValue > returns a null-prototype record so an injected key cannot be inherited`.

The second sabotage initially **passed**, which was a bug in the test rather than
in the guard: the test asserted that `Object.prototype` was not polluted, but
assigning `__proto__` on a plain object changes that object's prototype and
never touches `Object.prototype`. The real harm is an *inherited* value on the
returned record, so the assertion was rewritten to check
`Object.getPrototypeOf(value) === null` and that the injected key is not visible.
Only then did the sabotage fail. Recorded because the first version of the test
would have passed while the guard was removed.

Full workspace: `423 pass, 0 fail`, `bun run typecheck` clean for all six
packages.
