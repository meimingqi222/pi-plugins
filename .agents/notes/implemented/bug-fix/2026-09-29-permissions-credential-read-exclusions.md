# Agent Note: A user-owned exclusion list for credential reads

Status: implemented
Partly-superseded-by: 2026-10-09-permissions-yolo-auto-allow.md

## Problem

Reading `.env` was the single largest source of permission prompts in real
usage: 16 of the 30 `dangerous`/`forbidden` grades across 6902 recorded bash
commands were reads of the user's own credential files (`.env`, `auth.json`,
`~/.aws/credentials`).

There was no way to say "in my own projects, reading `.env` is fine":

- `path-policy.ts` documented the lists as "User config can append entries but
  never remove these";
- `decide.ts` returns `allowAlwaysOffered: false` for `dangerous`, so the prompt
  offers no "always allow" and no rule can be persisted from the UI;
- allow rules are evaluated *after* the dangerous floor, so a hand-written
  `allow` rule cannot lift it either.

Upstream splits two ways. minimax-code runs its credential/`.env` safety check
before the allow-rule scan (`tools/fs-permission.ts`, step order 1→6), so a user
rule cannot lift it; the only relief is `classifierApprovable: true`, a per-call
LLM verdict, and `bypassImmune` keeps it asking even in bypass mode. Step-Code
carries no credential list in `src/` at all: the practice is user-owned config —
`examples/extensions/sandbox/index.ts` ships `denyRead: ["~/.ssh", "~/.aws",
"~/.gnupg"]` / `denyWrite: [".env", ".env.*", "*.pem"]` as settings the user
edits. Neither offers a middle: a built-in list the user can carve out of.

## Decision

A `protectedPaths.read` entry starting with `!` is an exception, evaluated with
the same glob matching as the built-in `**/.env.example` exception table:

```jsonc
{ "protectedPaths": { "read": ["!**/.env"] } }
```

A matching **read** is no longer a credential read and falls through to
`safe` / `path-read`.

- **Global file only** (its top level or its `projects[<cwd>]` section). A
  project's `.pi/permissions.json` may still add protected paths but never remove
  them, so a repository cannot unprotect its own `.env` later; a `!` entry there
  is ignored with a warning rather than silently.
- **Reads only.** Writing a credential file stays dangerous, and the
  exfiltration rule keeps calling the un-excluded `isCredentialPath`, so
  `cat .env | curl …` is still `forbidden / secret-exfil` even after the user
  excludes `.env`.
- A `!` entry in `protectedPaths.write` is ignored with a warning: write
  protection is where self-escalation lives (pi's own config, extensions,
  `.git/**`, shell rc files).

## Alternatives considered

**Keep the lists unremovable (minimax-code's stance).** Defensible, but it leaves
the biggest prompt source with no user-side answer at all, and the user is the
one who owns the file being read.

**Honor exclusions from the project config too.** Convenient for per-repo
taste, but the project file is repository-controlled: a trusted repo could add
`!**/.env` in a later commit and quietly unprotect its own secrets. The global
file is hand-written by the user and already protected against model writes.

**Let an `allow` rule lift the credential check.** README's "allow never covers
the protected-path lists" exists so the model cannot grant itself access, and a
bash prefix rule is the wrong shape for a path decision anyway.

**Allow write exclusions as well.** That is the direction minimax-code was bitten
from — their own `permission.json` once sat in a write allowlist, which is why
list B exists here. Reading a secret and rewriting it are different risks; only
the first one needs a carve-out.

## Consequences

One line of global config silences `.env` reads in every project; `~/.ssh/**`,
`~/.pi/agent/auth.json` and the rest stay dangerous unless named explicitly.
Excluding `auth.json` unprotects the agent's own credentials — documented as a
deliberate choice, not a default.

An exclusion also cancels a user-added `protectedRead` entry, because exceptions
are evaluated first: `["**/secrets/**", "!**/secrets/public/**"]` carves a
readable subdirectory out of the user's own include. That ordering is the point
of the feature, not an accident.

## Verification

- `plugins/permissions/test/config.test.ts` — the global list splits into
  `protectedRead` + `protectedReadExclude`, a project-file `!` entry and a
  `protectedPaths.write` `!` entry are each ignored with a warning.
- `plugins/permissions/test/plugin.test.ts` — with a global exclusion for the
  project's .env, a `read` of `.env` is allowed with no dialog, while a `write` of
  the same path still prompts.

Proved: stubbed `isCredentialReadExcluded` to `return false` →
`bun test plugins/permissions/test/plugin.test.ts` reported `24 pass, 1 fail`
with the exclusion case failing, then restored → `25 pass, 0 fail`.


## Superseded

The classifier/path-boundary decision still holds. The universal dangerous
confirmation requirement, including claims that yolo asks or headless yolo
denies dangerous calls, is replaced by the successor: YOLO allows dangerous
classifications unless an explicit user rule restricts the call. Ask/auto
retain guarded confirmation and forbidden operations remain denied.
