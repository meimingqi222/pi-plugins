# AGENTS.md

Guidance for coding agents working in this repository.

## Layout

This is an npm/bun workspace of independent pi extensions. Each plugin is its
own package under `plugins/<name>`, versioned and published separately. Shared
dev tooling lives at the root; runtime dependencies live in the plugin that
uses them. Regression notes are shared across the whole repo in `.agents/notes/`.

See `README.md` for the full layout and how to add a plugin.

## Regression notes

Every non-trivial bug fix ships one regression note and one regression test in
the same change. The note records the problem, the decision, the alternatives
considered, and the consequences; the test pins the behavior. A `## Verification`
section names the test path and records the red-run proof.

Note paths are relative to the repository root, so moving or renaming a plugin
means updating every note that cites its tests. Run the verifier after any
move:

```bash
sh scripts/verify-notes.sh
```

Trivial mechanical edits with no behavior change are exempt.

## Credential-shaped test fixtures

**This repository is a secret-redaction tool, so its tests must contain strings
that look like secrets. Do not write them as contiguous literals.**

A contiguous `ghp_…`, `AKIA…`, `xoxb-…`, `sk-ant-…`, JWT or PEM header in the
source has two costs:

1. **GitHub push protection refuses the push.** It scans commits, so fixing the
   working tree is not enough — the literal has to be absent from history too.
   This repository's first push was blocked on a Slack fixture.
2. **Every scan reports false positives**, which trains people to ignore the
   scanner.

Put fixture values in `plugins/redact/test/fixtures.ts`, assembled from two
concatenated halves:

```ts
// Recognised by: github-pat.
export const GITHUB_PAT = "ghp_abcdefghijklmnop" + "qrstuvwxyz1234567890";
```

Rules for the split:

- **Neither half may match a rule on its own.** A half long enough to match is
  flagged exactly like the whole value. Do not split at the midpoint by
  assumption — the guard test below fails if a half matches.
- The runtime string must stay byte-identical, so tests keep exercising the real
  rule.

`plugins/redact/test/no-secrets.test.ts` enforces all of this, using the
plugin's own `SECRET_PATTERNS` as the oracle. Run it directly when working on
fixtures:

```bash
bun test plugins/redact/test/no-secrets.test.ts
```

It also runs as part of `bun run test`, and a `pre-commit` hook blocks a commit
that reintroduces a literal.

### Diagnosing a blocked push

If a push is rejected with `Push cannot contain secrets`, do not click through
the unblock URL — remove the literal and amend, so it never reaches history:

```bash
git add -A && git commit --amend --no-edit
git push
```

If the literal is in an older commit, rewrite that commit (interactive rebase or
`git filter-repo`) before pushing. GitHub scans every commit in the push, not
just the tip.

**A trap when reviewing this repository:** `pi-redact` may be loaded in your own
session (symlinked under `~/.pi/agent/extensions/`), in which case it rewrites
secret-shaped text **inside your tool output**. `grep` and file reads then show
`[REDACTED:…]` where the file actually holds a real-shaped value, and two scans
of the same file disagree. When a finding matters, confirm it on bytes — print
`line.encode().hex()` from Python rather than trusting the rendered text.

## Before committing

```bash
bun run typecheck
bun run test
bun run notes
```

`bun run notes` wraps `sh scripts/verify-notes.sh`, which searches the standard
Agent Skills locations for the verifier instead of assuming one layout. The
`pre-commit` hook runs the same two gates (notes tree, credential-shaped
literals); enable it once per clone:

```bash
git config core.hooksPath .githooks
```

On Windows, `bun run` does not put the Python launcher on PATH, which is why the
notes check goes through a shell script rather than a bare `python …` script
entry.

## Windows note

Under Git Bash, `ln -s` silently copies unless `MSYS=winsymlinks:nativestrict`
is set. A copied extension directory goes stale the moment the source changes,
so prefer `mklink /D` and confirm the result is a real link.
