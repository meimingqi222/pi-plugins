# Agent Note: Make the smoke gate runnable on Windows

Status: implemented
Partly-superseded-by: 2026-10-03-smoke-npm-argv.md

## Problem

`bun run smoke` failed on Windows with `Error: spawnSync npm ENOENT`, before any
extension was loaded. The failure looks like a missing npm, but `npm --version`
returns 10.9.3 in the same terminal. The cause is that Windows ships npm as
`npm.cmd`, and `child_process.spawnSync` cannot execute a `.cmd` without a
shell. `execFileSync("bun", …)` in the same script works, because bun ships as
`bun.exe`.

The consequence is the expensive one: `smoke` is the only gate that verifies a
packed extension actually loads in an isolated install, and it is documented as
part of the `pre-push` gate. On Windows it could never run, so a packaging
regression would sit green until CI on Linux caught it after the push.

## Decision

Pass `shell: true` to the npm spawn, scoped to `process.platform === "win32"`.
The CI path stays byte-identical, and the fix is the one the platform requires
rather than a rewrite of the install step.

## Alternatives considered

**Switch the installer to bun.** It changes what the gate verifies. `npm` with
`--legacy-peer-deps` is the stricter, more realistic install path for a
published package, and it is the one a user hits.

**Skip `smoke` on Windows.** Leaves the packaging gap open on the platform this
repository is developed on, which is where a packaging regression would be
written in the first place.

**Invoke `npm.cmd` explicitly.** Works, but hardcodes a Windows detail at the
call site instead of the one place the platform is already being branched on.

## Consequences

`smoke` now runs to completion on Windows and reports
`Loaded 10 packed extensions from an isolated install.` Packing (`bun pm pack`)
was never affected, so the tarball side of the gate was already verified; only
the install and load steps were unreachable.

## Superseded

The successor replaces shell execution with direct npm CLI execution on Windows
because the shell loses argument boundaries for paths containing spaces.

## Verification

- `scripts/smoke-packages.mjs` — run via `bun run smoke`

Proved: `node -e "spawnSync('npm',['--version'])"` returned
`{"status":null,"err":"ENOENT"}` while `shell:true` returned `{"status":0,"out":"10.9.3"}`,
confirming the shim rather than a missing npm; `bun run smoke` then loaded 10
packed extensions on Windows where it previously exited 1 before installing.
