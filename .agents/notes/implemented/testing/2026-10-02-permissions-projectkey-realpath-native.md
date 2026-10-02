# Agent Note: Key the permissions test by the same realpath the plugin uses

Status: implemented

## Problem

Two `pi-permissions` extension-wiring tests failed on Windows, on any machine
whose `%TEMP%` contains an 8.3 short-name component (`…/MEIMIN~1/…`):

- `an always-allow rule persists under the realpath'd cwd and is read back`
- `dangerous rm outside scratch: granting the directory persists it and silences
  the next call`

The diff was exactly one path component: the plugin persisted
`…/meimingqi222/…` while the test expected `…/MEIMIN~1/…`.

`pi-permissions` keys `projects[<cwd>]` through `createPolicyEnv().cwd`, which
realpaths with `fs.realpathSync.native()` — on Windows that goes through
`GetFinalPathNameByHandle` and expands a short component to its long form. The
test's own `projectKey()` helper called plain `fs.realpathSync()`, which resolves
junctions but leaves a short component untouched. So the grant was written under
one key and asserted under another, and the read-back test could never see it.

## Decision

Make the test helper use `fs.realpathSync.native()` so it derives the key the way
the plugin derives it. The product is unchanged: it reads and writes through the
same `.native` call, so it is self-consistent, and the failure was the assertion
being wrong rather than the grant being lost.

## Alternatives considered

**Make the product use the non-native realpath.** That would *not* fix it: it
would move the disagreement to the machine direction that already works, and it
would lose the long-name canonical form that `.native` deliberately buys.

**Normalize both forms on read.** Adds a second key shape to a persisted
security file, so an old key and a new key both load. Fixing the test needs
neither.

**Skip the assertion on Windows.** The assertion is the point of those tests.

## Consequences

Both tests pass on a short-`%TEMP%` machine, which is the default for some
Windows installations rather than an exotic one. The trap generalises: any test
that has to predict a path this plugin persists must use `.native`, and the
comment on `projectKey` now says so, next to the existing note about `/`
separators.

## Verification

- `plugins/permissions/test/plugin.test.ts::an always-allow rule persists under the realpath'd cwd and is read back`
- `plugins/permissions/test/plugin.test.ts::dangerous rm outside scratch: granting the directory persists it and silences the next call`

Proved: before the helper change, the first test failed with
`expected "…/MEIMIN~1/…", received "…/meimingqi222/…"` and the second with
`saved.projects[projectKey(dir)]` undefined; after switching the helper to
`realpathSync.native`, both pass — 127 pass, 0 fail for the plugin.
