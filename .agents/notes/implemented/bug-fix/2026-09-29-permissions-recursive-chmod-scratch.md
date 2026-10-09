# Agent Note: Recursive chmod/chown inside scratch space is not a broad permission change

Status: implemented
Partly-superseded-by: 2026-10-09-permissions-yolo-auto-allow.md

## Problem

A verification run in a temp workspace was hard-blocked:

```
chmod -R 755 /tmp/perm-verify/readonly-sub
→ Blocked by pi-permissions (dangerous, permission-broad):
  broad permission change (chmod 777/-R, chown -R, icacls /grant).
  No approval is possible in this run (headless).
```

`hitPermissionBroad` was purely flag-based: any `chmod` carrying `-R` was
dangerous, and `dangerous` is an ask, which in a headless or delegated run
becomes a denial. The target was never consulted, so a recursive chmod on a
directory the caller owns under `/tmp` — or `chmod -R 755 ./dist` inside the
workspace — cost the same as `chmod -R 755 /usr/local/lib`.

This is the same misjudgment as the `rm-root` temp bug (see
`2026-09-29-permissions-rm-temp-boundary.md`): `tempDirs` and the workspace are
the policy's own declaration of scratch space, and `rm` already treats them that
way. It was also the last hard block in a scan of the real session history.

## Decision

Split the rule into its two independent risks. A broad **mode** (`777`,
`a+rwx`, `a=rwx`, `o+w`) stays dangerous wherever it lands — world-writable is a
security problem in any directory. A **recursive** change is dangerous only when
it can reach beyond scratch:

```ts
if (command.name === "chmod") {
  const broadMode = command.args.some((arg) => arg !== undefined && /777|a\+rwx|a=rwx|o\+w/u.test(arg));
  if (broadMode) return true;
  return isRecursive(command) && !recursiveTargetsAreScratch(command, env);
}
```

`recursiveTargetsAreScratch` requires **every** operand to resolve strictly
inside `env.cwd`, an `additionalDirs` entry, or a `tempDirs` entry. Three guards:

- *strictly* inside, so `chmod -R 755 .` (the workspace root) still asks;
- every operand, so `chmod -R 755 /tmp/x /etc` still asks;
- a dynamic operand is refused (`undefined` after parsing), so
  `chmod -R 755 $DIR` still asks — the target cannot be proven scratch.

`chown` follows the same split; `takeown` and `icacls /grant` are unchanged.
Recursive changes inside scratch now grade grey: allowed in yolo, asked in
ask/auto, still denied in read-only.

## Alternatives considered

**Keep `-R` dangerous everywhere and let the user allow-list.** The plugin has
no path-scoped allow rule for exec intents, and a headless run cannot ask at
all, so there is no way to unblock the shape once it fires.

**Also treat the workspace root as scratch.** `chmod -R 000 .` would then run
silently in yolo and leave the tree unusable. `rm` already distinguishes the
workspace root from its contents, and the same line is drawn here.

**Narrow only the temp dirs, not the workspace.** It would clear the observed
block with less surface, but leaves `chmod -R 755 ./dist` asking while
`rm -rf ./dist` is grey — the same inconsistency the temp exemption was added to
remove.

**Drop the rule and rely on the OS sandbox.** minimax-code keeps an
unconditional `chmod -R` pattern (its SOFT risk list), and Step-Code has no
chmod rule at all; neither offers a path-aware middle. Keeping the rule with a
path dimension preserves the guard on system trees.

## Consequences

`chmod -R`/`chown -R` on paths strictly inside the workspace or a temp dir are
grey; on the workspace root, system trees, or anything unprovable they still ask.
`chmod 777` is unaffected: still dangerous on a temp dir too, because the mode
itself is the risk.

The path dimension costs one `normalizePath` per operand on the `chmod`/`chown`
path only.

## Verification

- `plugins/permissions/test/decide.test.ts` — cases 46–49, added with this fix. Case 46 is the blocked shape (`chmod -R 755` on a temp dir) and grades grey; case 47 pins that the workspace root itself is not scratch; case 48 pins a system tree; case 49 pins that the broad-mode clause is path-independent.

Proved: stubbed `recursiveTargetsAreScratch` to `return false` →
`bun test plugins/permissions/test/decide.test.ts` reported `51 pass, 1 fail`
with case 46 failing (`Expected: "allow" / Received: "deny"`), then restored →
`52 pass, 0 fail`. Also re-ran the classifier over the recorded commands:
`chmod -R 755 /tmp/perm-verify/readonly-sub` → grey, `chmod -R 755 /usr/local/lib`
and `chmod 777 /tmp/x` → dangerous.


## Superseded

The classifier/path-boundary decision still holds. The universal dangerous
confirmation requirement, including claims that yolo asks or headless yolo
denies dangerous calls, is replaced by the successor: YOLO allows dangerous
classifications unless an explicit user rule restricts the call. Ask/auto
retain guarded confirmation and forbidden operations remain denied.
