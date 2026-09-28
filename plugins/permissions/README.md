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

| tier \ mode | read-only | ask | auto | yolo |
|---|---|---|---|---|
| safe, read-only | allow | allow | allow | allow |
| safe, mutating | **deny** | ask | allow | allow |
| grey | deny | ask | reviewer model¹ | allow |
| dangerous | deny | ask | ask | **ask** |
| forbidden | deny | deny | deny | deny |

¹ In `auto`, a grey call first tries the reviewer model (if configured) and
the sandbox bypass (if enabled); a deny verdict still asks — the reviewer is
advisory, never the authority. An explicit `ask` rule is never overridden.

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
  "reviewer": { "model": "jev", "timeoutMs": 15000, "maxPerSession": 100 },
  "sandbox": { "enabled": false, "network": "on", "allowWrite": [], "denyRead": [] },
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
- `/permissions sandbox [on|off [--save] | status]` — optional OS sandbox; status shows the mechanism and policy size.
- `/permissions reload` — re-read the config files.

## Reviewer (auto mode)

In `auto`, a grey call is first judged by a reviewer before a human is asked.
`allow` releases it; `ask`/`deny`/timeout/error fall back to the human prompt —
a deny just annotates the prompt. Results are cached per identical call and
capped at `maxPerSession` real calls per session. Two backends:

- **`"jev"`** (the default) — the TypeSafe System One endpoint, a purpose-built
  fast decision model. Key resolution is shared with pi-jev-compact:
  `TYPESAFE_API_KEY` → `~/.pi/agent/jev-compact.json` (`{"apiKey": …}`) →
  `auth.json["typesafe"]`; `JEV_COMPACT_MODEL`/`JEV_COMPACT_BASE_URL` override
  the endpoint. It is *not* a pi model provider. With no `reviewer` section at
  all the reviewer still activates when a Jev key exists.
- **`"provider/model-id"`** — any model registered in pi's model registry,
  judged via an isolated tool-free call (prompt-injection hardened system
  prompt; the call is `DATA`, never instructions), e.g.
  `"anthropic/claude-haiku-4-5"`.

Set `reviewer.model` to `"none"` to disable the reviewer entirely. The section
honours the usual trust rules: a project's `reviewer` config only applies when
the project is trusted.

## Sandbox

Off by default. When on (`/permissions sandbox on`, or `sandbox.enabled` in
config), every **allowed** bash command is rewritten to run inside:

- **macOS**: `/usr/bin/sandbox-exec` with a generated seatbelt profile
  (verified on macOS 27). Writes confined to the workspace, temp dirs, and
  package caches (`~/.npm`, `~/.cache`, …); `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gcloud`, `~/.azure`, `~/.kube` and `~/.pi/agent/auth.json` are
  unreadable. `sandbox.network: "off"` denies all outbound TCP including
  localhost — `npm install` will fail; keep it `on` for normal work.
- **Linux**: `bwrap` when on PATH and usable (probed once per session —
  containers without user namespaces report unavailable).
- **Windows**: not supported — `unavailable on win32 (policy only)`; use WSL
  or a container for real isolation.

The rewrite happens inside `tool_call`, so it covers both pi's builtin bash
and `pi-bg-bash` without replacing either tool. In `auto` mode a sandboxed
grey bash call skips the reviewer entirely — except exfil-shaped commands
(`curl`, `wget`, `nc`, `scp`, `rsync`, `ssh`, …), which still go to the
reviewer or the user.

Known side effect: extensions whose `tool_call` handler runs after this plugin
see the *rewritten* command (e.g. a bare-`sleep` detector sees the wrapper).

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
