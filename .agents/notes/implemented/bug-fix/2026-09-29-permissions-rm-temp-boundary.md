# Agent Note: Keep temp-dir contents out of the rm-root filesystem boundary

Status: implemented

## Problem

A real agent session had this bash call blocked outright, in `yolo` mode:

```
rm -rf /tmp/trae-acp-verify && mkdir -p /tmp/trae-acp-verify && cd /tmp && cat > /tmp/acp_verify.js <<'EOF' …
```

```
Blocked by pi-permissions (rm-root): recursive force-delete aimed at a filesystem boundary. This is never allowed.
```

The scratch-directory cleanup that opens half of all agent shell calls could not
run, and `forbidden` is an absolute floor in `decide.ts` — no approval path, no
rule that lifts it.

Reproduced against the recorded tool call with the production `createPolicyEnv`:
the `rm` intent graded `forbidden / rm-root`, every other intent grey or safe.

The cause is a realpath asymmetry in `hitRmRoot`. `normalizePath` realpaths every
target, and `SYSTEM_DIRS` carries the literal `/private` to cover the macOS
system directories that live behind symlinks (`/etc` → `/private/etc`,
`/var` → `/private/var`). `/tmp` is also a symlink to `/private/tmp`, so
`rm -rf /tmp/trae-acp-verify` normalizes to `/private/tmp/trae-acp-verify`, which
is inside `/private` — a boundary. Every path under `/tmp` and `/var/folders`
read as a filesystem boundary, which on macOS is exactly the scratch space the
policy elsewhere treats as safe (`hitRmRecursiveForce` already lists `tempDirs`
as safe targets).

The reason the suite never caught it: the darwin fixture's `realpath` was the
identity function, so `/tmp` never became `/private/tmp` in any test. The design
doc already requires fixtures to model the realpath (`/tmp` → `/private/tmp`).

## Decision

A target strictly below a temp dir is not a filesystem boundary; the temp dir
itself still is:

```ts
if (SYSTEM_DIRS.some((dir) => isInside(target, dir, env)) && !insideTempDir(target, env)) return true;
```

`insideTempDir` uses a new `isStrictlyInside` in `paths.ts` (inside, but not
equal, with the case folding kept in one place). The exemption is scoped to the
`SYSTEM_DIRS` clause only — the filesystem root, home, and the literal `/*` /
`~` / `*` branches are untouched.

The darwin test fixture now models the platform: a longest-prefix link table maps
`/tmp` → `/private/tmp` and `/var` → `/private/var` (so a link on a directory
covers its children the way a real symlink does), and `tempDirs` includes
`/private/var/folders` for the per-user TMPDIR, mirroring `createPolicyEnv`.

## Alternatives considered

**Drop `/private` and realpath each `SYSTEM_DIRS` entry.** `/etc` would still be
covered, because realpath(`/etc`) is `/private/etc`. But `/private/var/db` and
`/private/tmp` would lose their protection, and `rm -rf /tmp` would fall through
to `rm-recursive-force`, which counts temp dirs as safe — deleting the temp root
would become a grey yolo-allow. A bug fix should not loosen a forbidden rule
wider than the bug requires.

**Adopt the structural rule "a direct child of the filesystem root is a
boundary"** (minimax-code, `tools/fs-permission.ts` `isDangerousRemovalPath`:
root, home, system drive roots, and direct children of root such as `/usr`,
`/etc`, `/var`). That model avoids this false positive, but only because it
never realpaths: once paths are realpath'd, `/private/tmp` and `/private/etc`
are no longer direct children of `/`, so the rule opens a hole precisely where
the fixed list over-blocks. minimax-code also recognises temp paths as their own
case (`isTempDirectory` covers `os.tmpdir()` and the `/tmp` prefix, and
`tools/path-capability.ts` returns an explicit `allow` for them), which is the
half of its model adopted here.

**Treat any recursive-force remove as a flag match and always ask** (Step-Code,
`packages/coding-agent/src/step/command-policy.ts`: `isRecursiveForceRemove`
inspects only `-r`/`-f`, and the matched rule yields `confirm`, never a
path-classified deny). That shape cannot produce this false positive, but it
cannot separate `rm -rf /` from `rm -rf node_modules` either; path-classified
tiers are pi-permissions' contract, and design-doc case 2 pins that
granularity. The classification was kept and the comparison fixed.

**Keep the deny and tell the user to allow-list `/tmp`.** A permanent per-project
workaround for a wrong tier — and no rule can lift a `forbidden` tier anyway.

## Consequences

`rm -rf /tmp/<anything>` and `rm -rf /var/folders/…/<anything>` now grade `grey`,
so yolo allows them and ask/auto modes ask rather than deny. `rm -rf /tmp`,
`rm -rf /private/tmp` and `rm -rf /private/var/folders` stay `forbidden`, and
`/private/var/db` and `/etc` keep their protection.

`insideTempDir` adds one bounded check per operand on the `rm` path only.

Making the fixture realpath like production surfaced one stale assertion: the
sandbox policy test expected the literal `/tmp` in `writable`, but
`resolveSandboxPolicy` realpaths its inputs, so `/tmp` and `/private/tmp`
collapse to one entry — the assertion now names `/private/tmp`, which is what
production produces. The identity `realpath` had been hiding the platform.

Deliberate limit: a temp dir configured *inside* a protected tree (`TMPDIR=/usr/tmp`)
exempts that subtree from the system-dir clause. `tempDirs` is the policy's own
declaration of scratch space, read from the plugin's environment rather than
from the command, and `hitRmRecursiveForce` already trusts it the same way.

## Verification

- `plugins/permissions/test/decide.test.ts` — cases 38–41, added with this fix. Case 38 (`rm -rf /tmp/scratch`) is the reported shape end-to-end through `decide` in yolo mode; case 39 is the macOS per-user TMPDIR reached through the `/var` link; case 40 is the already-realpath'd spelling, so a fix cannot special-case the literal `/tmp`; case 41 (`rm -rf /tmp`) is the no-loosening pin and passed before the fix as well.

Proved: restored the two `src` files to their pre-fix state (keeping the fixture
and the four cases) → `bun test plugins/permissions/test/decide.test.ts` reported
`41 pass, 3 fail`, with 38/39/40 failing as `Expected: "allow" / Received: "deny"`,
then re-applied the fix → `44 pass, 0 fail`. Full plugin suite after the fix:
`114 pass, 0 fail`. Re-checked the recorded session command through
`createPolicyEnv`: the `rm` intent is `grey` and `decide(…, "yolo", …)` returns
`allow`, while `rm -rf /`, `rm -rf ~`, `rm -rf /etc`, `rm -rf /private/var/db/x`
and `rm -rf /tmp` still return `deny / forbidden / rm-root`.
