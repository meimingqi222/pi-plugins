# Agent Note: The `projects[<cwd>]` key must be the realpath'd cwd

Status: implemented

## Problem

`loadState` read the per-project section with `ctx.cwd`:

```ts
mergeConfig(globalFile(), projectFile(ctx.cwd), trusted, ctx.cwd);
```

but every grant is *written* under `env.cwd`, which `createPolicyEnv` has already
realpath'd (`appendProjectAllowRule(globalFile(), env!.cwd, rule)`). With a
symlinked cwd the two disagree — `/tmp/x` vs `/private/tmp/x`, `/var/folders/…`
vs `/private/var/folders/…`, or a linked checkout — so an "Always allow in this
project" rule was persisted under one key and looked up under another.

The rule therefore never applied, and it failed *silently*: the prompt offered
the option, the file showed the entry, and the next identical call asked again.
The design doc already required the key to be the "规范化绝对路径" of the project
root, so this was a deviation, not a decision.

Found while implementing the directory grant
(`2026-09-29-permissions-outside-workspace-directory-grant.md`): the grant was
persisted correctly and the next call still prompted. The existing tests missed
it because they either call `appendProjectAllowRule` with an explicit key, or
exercise the *session* rule path, which is in-memory and key-free.

## Decision

One canonical key, used for the lookup:

```ts
const canonicalCwd = (cwd: string): string => createPolicyEnv(cwd, []).cwd;
```

`createPolicyEnv` is called twice per load — once with no extra directories to
canonicalize the key, once with the merged `additionalDirectories` — because the
merge needs the key and the env needs the merge. The second call is what the
policy uses; the extra one costs a few `realpath` syscalls on session start and
after a grant.

Writes already used `env.cwd`, which is the same value, so no write changed.

## Alternatives considered

**Write with `ctx.cwd` instead.** Cheaper, but then one project has two rule sets
depending on how it was spelled, and `/tmp/x` rules would not follow the user to
`/private/tmp/x`. The canonical key is the identity; the spelling is not.

**Realpath only when a project section is present.** Same syscalls in the common
case that has no sections, but it makes the key depend on the file's contents —
one `projects[<cwd>]` entry would silently change the identity of the project.

**Leave it and document "use the realpath'd path in config keys".** The prompt
writes the key, not the user, and the failure mode is a silent no-op.

## Consequences

An entry previously written under the canonical key starts working, and a
symlinked project shares one rule set across both spellings. A config written
under the raw spelling (which never applied) keeps not applying — correct, since
it never took effect.

The cost is one extra `createPolicyEnv` per state load; `loadState` runs on
session start and after a directory grant.

## Verification

- `plugins/permissions/test/plugin.test.ts` — with a symlinked cwd, "Always allow
  in this project" persists under `fs.realpathSync(cwd)`, and a *fresh session*
  started at the same linked cwd finds the rule (no second dialog).

Proved: restored the raw key (`trusted, ctx.cwd`) →
`bun test plugins/permissions/test/plugin.test.ts` reported `23 pass, 2 fail`
with the symlinked-cwd case failing, then re-applied → `25 pass, 0 fail`.
