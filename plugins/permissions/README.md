# pi-permissions

A small permission layer for [pi](https://pi.dev): every tool call is graded
into a tier, and the mode decides whether it runs, asks, or is denied.

**This is not a security boundary.** It is a deterministic policy layer that
catches destructive commands, credential reads, and writes to protected paths.
It cannot stop deliberately obfuscated commands — see *Not covered* below.

```bash
pi install -l ./plugins/permissions
```

## Modes

The default mode is `yolo` — the plugin behaves like stock pi except that the
dangerous/forbidden tiers still apply.

| tier \ mode | read-only | ask | auto (P1) | yolo |
|---|---|---|---|---|
| safe, read-only | allow | allow | allow | allow |
| safe, mutating | **deny** | ask | allow | allow |
| grey | deny | ask | ask¹ | allow |
| dangerous | deny | ask | ask | **ask** |
| forbidden | deny | deny | deny | deny |

¹ P2 will route grey calls in `auto` through a small reviewer model first;
in P1 `auto` behaves like `ask` for grey.

"Ask" in a context where nobody can answer (delegated children, `--mode json`)
becomes a denial with an explanation.

## Tiers

| tier | meaning | examples |
|---|---|---|
| `safe` | provably harmless | `git status`, reading files, writes inside the workspace |
| `grey` | cannot be proven harmless | `npm test`, unknown commands, writes outside the workspace |
| `dangerous` | can cause damage or leaks — **always asks** | `git push --force`, `sudo`, `npm publish`, reading `~/.ssh`, writing `.env` |
| `forbidden` | unrecoverable or clearly malicious — **always denied** | `rm -rf /`, `mkfs`, reverse shells, credentials piped to `curl` |

### Rule ids

Forbidden: `rm-root` (recursive force-delete at a filesystem boundary),
`disk-format`, `disk-write`, `shadow-copy-delete`, `reverse-shell`,
`secret-exfil` (credential file piped to a network command).

Dangerous: `rm-recursive-force` (workspace root / `.git` / outside-workspace
targets), `git-destructive`, `privilege-escalation`, `permission-broad`,
`system-lifecycle`, `publish`, `destructive-sql`, `pipe-to-shell`,
`windows-destructive`, `crontab-remove`, `sensitive-path`, `protected-write`.

## Protected paths

Reading **or** writing these is dangerous (`sensitive-path`):

```
~/.ssh/**  ~/.aws/**  ~/.gnupg/**  ~/.config/gcloud/**  ~/.azure/**
~/.kube/config  ~/.docker/config.json  ~/.netrc  ~/.npmrc  ~/.pypirc
~/.git-credentials  ~/.pi/agent/auth.json
**/.env  **/.env.*  **/*.pem  **/*.key  **/id_rsa*  **/id_ed25519*  **/id_ecdsa*
```

(`.env.example`/`.sample`/`.template` are exempt.)

Writing these is dangerous (`protected-write`); reading them is ordinary:

```
~/.pi/agent/permissions.json  <cwd>/.pi/permissions.json
~/.pi/agent/settings.json     <cwd>/.pi/settings.json
~/.pi/agent/extensions/**     <cwd>/.pi/extensions/**
~/.pi/agent/trust.json
<cwd>/.git/**
~/.bashrc  ~/.bash_profile  ~/.profile  ~/.zshrc  ~/.zprofile  ~/.zshenv
~/.config/fish/**
~/Documents/PowerShell/**  ~/Documents/WindowsPowerShell/**
```

## Configuration

| file | role |
|---|---|
| `~/.pi/agent/permissions.json` | global config; "always allow" rules land here |
| `<cwd>/.pi/permissions.json` | project config, constrained by project trust |

```jsonc
{
  "version": 1,
  "mode": "yolo",
  "allow": ["bash(npm test:*)", "edit(src/**)"],
  "ask": ["bash(docker:*)"],
  "deny": ["read(**/secrets/**)"],
  "additionalDirectories": ["~/work/shared-lib"],
  "protectedPaths": { "read": [], "write": [] },
  "projects": {
    "/Users/me/work/app": { "allow": ["bash(make build:*)"] }
  }
}
```

**Trust rules.** An *untrusted* project can only tighten: its `allow` and
`additionalDirectories` are ignored and its `mode` applies only when stricter
than the global one. A *trusted* project may also loosen. `deny`, `ask`, and
`protectedPaths` always apply. Nothing can downgrade the dangerous/forbidden
floors, and `allow` never covers the protected-path lists.

Mode precedence: inherited (children) → `PI_PERMISSIONS_MODE` → session
(`/permissions mode`) → project → global → `yolo`.

## Commands

- `/permissions` — mode, source, config files, rule counts, invalid rules.
- `/permissions mode <read-only|ask|auto|yolo> [--save]` — session mode; `--save` writes the global file.
- `/permissions rules` — effective rules with their source.
- `/permissions check <tool> <input>` — classify without executing, e.g. `/permissions check bash rm -rf /`.
- `/permissions reload` — re-read the config files.

## Delegated children

`pi-agent-runner` sets `PI_AGENT_CHILD=1` in spawned agents. Inside one, the
plugin inherits the parent's effective mode via `PI_PERMISSIONS_INHERITED_MODE`
and **never prompts**: anything that would ask is denied with a headless
explanation, so a subagent cannot hang on a dialog nobody can see.

## Not covered

- The extension's own code — extensions run with pi's privileges.
- Commands the user types with `!` (`user_bash`) — those are already trusted.
- Third-party extension tools — they are graded by name only ("unknown tool" →
  grey) because the plugin cannot see inside their parameters.
- Deliberately obfuscated evasion (write a script file, then run it). Static
  analysis is a guardrail, not a sandbox. For real isolation use the planned
  optional sandbox (macOS/Linux), a container, or a VM.
- Windows gets no OS-level sandbox even in P3 — the policy layer still applies.

## Env variables

| variable | effect |
|---|---|
| `PI_PERMISSIONS_MODE` | force a mode (below child-inherited, above session/project/global) |
| `PI_PERMISSIONS_INHERITED_MODE` | written by the parent for delegated children; ignored in the parent |
| `PI_AGENT_CHILD` | set by `pi-agent-runner`; makes every ask a denial |
