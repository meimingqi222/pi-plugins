# Agent Note: Resolve the Jev API key from auth.json, not only the environment

Status: implemented

## Problem

`pi-jev-compact` read the TypeSafe key from exactly one place:

```ts
function resolveApiKey(): string | undefined {
  const raw = process.env.TYPESAFE_API_KEY;
  ...
}
```

The README documented this as a deliberate constraint, with a code comment
giving the reason:

> There is no `auth.json` option. `ctx.modelRegistry.getApiKeyForProvider(id)`
> returns `undefined` for any id that is not a registered model provider, and
> `typesafe` is not one, so an `auth.json` entry would never be found.

That reasoning is correct about `getApiKeyForProvider`, which resolves through
the model registry — but it does not follow that `auth.json` is unusable. The
conclusion was drawn from the wrong API.

Two costs follow from the environment-only rule:

1. **A GUI-launched pi cannot see an export.** Shell rc files are read by
   *interactive* shells. A pi started from Finder/Dock, or spawned by another
   app, never sources `~/.zshrc`, so the documented setup silently does nothing
   and the plugin falls back to pi's own compaction.
2. **The failure is a degraded compaction, not an error.** Compaction still
   succeeds; it just uses pi's summary instead of the Jev-pruned transcript. A
   user who set the variable in the wrong file gets worse results with no signal
   beyond a startup notice they may not have been watching for.

## Decision

Add `src/api-key.ts` with a resolver over three sources, in priority order:

1. `TYPESAFE_API_KEY` — the environment, so an explicit export always wins.
2. `<agent dir>/jev-compact.json` — `{ "apiKey": "..." }`, the plugin's own file.
3. `<agent dir>/auth.json` — the credential file pi writes, under the provider id
   `typesafe`.

`auth.json` is read **as a JSON file**, not through the model registry. That is
the correction to the original reasoning: the registry cannot resolve a
non-model provider, but the file can be parsed directly, and the entry is shape-
compatible with what pi stores.

Two properties make that safe rather than merely possible, both verified against
pi's implementation rather than assumed:

- **pi preserves foreign keys.** A credential is
  `ApiKeyCredential = { type: "api_key", key?, env? }`, and pi's write path is
  `delete currentData[provider]` followed by `JSON.stringify(currentData, null, 2)`
  (`dist/core/auth-storage.js`). A key it does not recognise is carried through
  untouched.
- **`typesafe` collides with nothing.** It is not among pi's 41 builtin provider
  ids, so it cannot hijack an existing credential.

The resolver never throws. A malformed or unreadable file falls through to the
next source, because the failure mode of a missing key is already a fallback to
pi's compaction, and turning an unrelated file problem into a crash would be
worse.

`normalize` now returns `{ key, repaired }` rather than a `ResolvedApiKey` with a
placeholder `source`. An earlier draft returned `source: "none"` from the
environment branch and let each caller overwrite it, which meant the environment
case reported `"none"` — a test caught it, and the type now makes the mistake
unrepresentable.

## Alternatives considered

**Keep environment-only and document `PI_CODING_AGENT_DIR` + a wrapper script.**
Pushes the problem onto the user and still fails for a GUI launch.

**Use `ctx.modelRegistry.getApiKeyForProvider("typesafe")`.** Does not work, for
the reason the original comment gives. Registering a fake *model* provider to
make it work would pollute the model picker with a provider that serves no models.

**Store the key in pi's `settings.json`.** pi has no environment or secret
section in settings (checked `docs/settings.md`); settings hold preferences, not
credentials, and writing a secret there would be a new place for it to leak.

**Read `auth.json` only, dropping the environment.** Breaks CI and existing
setups, and removes the ability to override a stale stored value without editing
a file.

## Consequences

- The key can live where it is appropriate for the machine. `auth.json` is the
  one place pi already keeps credentials with `0600` permissions.
- Precedence is explicit and documented, so a stale stored value is overridden by
  an export rather than fighting it.
- The missing-key notice now names the alternatives instead of telling the user
  to export a variable.
- Tests that previously read only the environment could silently pick up a
  developer's real `~/.pi/agent/auth.json`. `test/hook.test.ts` now redirects
  `PI_CODING_AGENT_DIR` to an empty temp directory per test, and `test/api-key.test.ts`
  injects a file reader instead of touching disk. `getAgentDir()` reads the env
  var on each call, so this redirect is effective without reloading the module.

## Verification

- `plugins/jev-compact/test/api-key.test.ts` — precedence (environment > config
  file > auth file, plus a custom provider id) and robustness (whitespace
  repair and reporting, whitespace-only treated as absent, malformed config
  file skipped rather than fatal, non-string `apiKey`, an **oauth** entry under
  the id not used as a bearer token, an `api_key` entry with no `key` ignored,
  other providers left alone, an array root rejected).
- `plugins/jev-compact/test/hook.test.ts` — end to end through the real hook:
  "a key stored in auth.json enables compaction", "a key stored in
  jev-compact.json enables compaction", "the environment overrides a stored key",
  and the updated missing-key and whitespace cases.

Proved: the environment branch returned `source: "none"`, and
"the environment wins over both files" failed with
`Expected: "environment"  Received: "none"`. Fixed by narrowing `normalize`'s
return type; 16/16 in the new file, 152/152 in the plugin.

Also verified against a real pi credential store outside the test suite: seeded
a temporary auth.json with a `typesafe` entry alongside `parallel` and
`copilot-api-chat`, then drove `AuthStorage.modify` for both a delete and an add.
All three keys survived, so a real login or logout does not drop the
plugin's key.
