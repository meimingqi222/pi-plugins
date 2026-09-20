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
python ../.agents/skills/regression-notes/scripts/verify-notes.py --notes-dir .agents/notes
```

Trivial mechanical edits with no behavior change are exempt.

## Before committing

```bash
bun run typecheck
bun run test
python ../.agents/skills/regression-notes/scripts/verify-notes.py --notes-dir .agents/notes
```

## Windows note

Under Git Bash, `ln -s` silently copies unless `MSYS=winsymlinks:nativestrict`
is set. A copied extension directory goes stale the moment the source changes,
so prefer `mklink /D` and confirm the result is a real link.
