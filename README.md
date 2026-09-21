# pi-plugins

A workspace of independent [pi](https://pi.dev) extensions. Each plugin lives
under `plugins/` as its own package, is versioned and published separately, and
can be installed without pulling in its siblings.

## Plugins

| Plugin | Package | What it does |
|--------|---------|--------------|
| [redact](plugins/redact) | `pi-redact` | Strips API keys, tokens and other secrets from every payload sent to a model, before it leaves your machine. |
| [jev-compact](plugins/jev-compact) | `pi-jev-compact` | Replaces compaction summaries with Jev-pruned transcripts — stale tool calls are deleted, text is never rewritten. |
| [ace-search](plugins/ace-search) | `pi-ace-search` | Semantic codebase retrieval (`ace_codebase_search`) over an Augment ACE index, reusing acemcp's blob hashes so a warm project uploads nothing. |
| [goal](plugins/goal) | `pi-goal` | Persistent, user-controlled session objectives with guarded continuations and isolated completion verification. |

Each plugin has its own README with configuration, architecture notes and
measured behaviour. `pi-jev-compact` additionally ships
[`ATTRIBUTION.md`](plugins/jev-compact/ATTRIBUTION.md), since its decision engine
is vendored from `fast-jev-compaction`.

### The plugins stay independent, but cooperate when both are installed

`pi-jev-compact` uploads a conversation to TypeSafe, which is traffic
`pi-redact`'s provider hooks never see. Instead of one plugin depending on the
other, `pi-redact` publishes a versioned redaction service on pi's shared event
bus (`pi.events`) and `pi-jev-compact` consumes it, so the same engine redacts
both destinations.

Either plugin installs and works alone. Load order does not matter, and the
`pi-jev-compact` startup notice states whether redaction is active. See
[`.agents/notes`](.agents/notes/implemented/bug-fix/2026-09-20-redact-provider-gap.md)
for the design and the alternatives rejected.

## Install

Each plugin is installed on its own:

```bash
pi install -l ./plugins/redact         # project-local
pi install -l ./plugins/jev-compact
pi install -l ./plugins/ace-search
pi install -l ./plugins/goal
pi install npm:pi-redact               # once published
```

`pi-jev-compact` needs a TypeSafe API key in the environment
(`TYPESAFE_API_KEY`); `pi-redact` has no required configuration.
`pi-ace-search` reads its endpoint and token from `~/.acemcp/settings.toml`, the
same file `acemcp` uses, and uploads source to that endpoint — see its
[README](plugins/ace-search/README.md).

To hack on a plugin against a live pi session, symlink its `src/` directory
into pi's global extension directory, where pi hot-reloads it with `/reload`:

```bash
ln -s "$PWD/plugins/redact/src" ~/.pi/agent/extensions/pi-redact
ln -s "$PWD/plugins/jev-compact/src" ~/.pi/agent/extensions/pi-jev-compact
```

On Windows under Git Bash, `ln -s` silently **copies** unless native symlinks
are enabled — pass `MSYS=winsymlinks:nativestrict` or use `mklink /D`, then
confirm with `os.path.islink`.

## Development

The repo is an npm/bun workspace. Install once at the root:

```bash
bun install
```

Then, from the root, the scripts fan out across every plugin:

```bash
bun run test        # bun test in each plugin
bun run typecheck   # tsc --noEmit in each plugin
bun run bench       # pi-redact micro-benchmarks
bun run compare     # pi-jev-compact quality comparison vs Morph
bun run accuracy    # pi-ace-search recall benchmark vs judged ground truth
bun run notes       # verify the regression-notes tree
bun run secrets     # reject credential-shaped literals in the source
```

To work in one plugin, `cd` into it and use its own scripts:

```bash
cd plugins/redact
bun test
bun run typecheck
bun bench/bench.ts
```

### Layout

```
pi-plugins/
├── package.json              workspace root (private, not published)
├── tsconfig.base.json        compiler options shared by every plugin
├── .githooks/pre-commit      regression-note gate (see below)
├── .agents/notes/            regression notes, one tree for the whole repo
└── plugins/
    ├── redact/
    │   ├── package.json      name: pi-redact — the published package
    │   ├── tsconfig.json     extends ../../tsconfig.base.json
    │   ├── README.md
    │   ├── src/              source (pi entry point is src/index.ts)
    │   ├── test/             bun tests
    │   └── bench/            benchmarks
    └── jev-compact/
        ├── package.json      name: pi-jev-compact — the published package
        ├── ATTRIBUTION.md    provenance of the vendored Jev engine
        ├── src/              source, incl. vendored src/jev/
        ├── test/
        └── bench/            quality comparison + session replay
    └── ace-search/
        ├── package.json      name: pi-ace-search — the published package
        ├── src/              client, chunker, index store, CLI, pi tool
        ├── test/             all network-free (fetch is stubbed)
        └── bench/            recall benchmark vs judged ground truth
```

### Adding a plugin

1. `mkdir plugins/<name>` and add a `package.json` named `pi-<name>` with a
   `pi.extensions` manifest pointing at its entry file.
2. Add a `tsconfig.json` that extends `../../tsconfig.base.json` and includes
   `src/**/*.ts` (plus `test/` and `bench/` if present).
3. Run `bun install` at the root so the workspace picks it up.
4. Add a `test` script (`bun test`) and a `typecheck` script (`tsc --noEmit`) so
   the root scripts pick it up. Add `bench`/`compare` only if the plugin has them.
5. Keep third-party runtime dependencies in that plugin's `dependencies`;
   shared dev tooling (`typescript`, `@types/*`) stays at the root.

## Regression notes

Every non-trivial bug fix ships one note and one regression test in the same
change. Notes live in `.agents/notes/` and are shared across all plugins — a
note binds to a test by path, so a plugin move must update the paths it cites.

```bash
bun run notes        # verify the regression-notes tree
bun run secrets      # reject credential-shaped literals in the source
```

Both also run as a `pre-commit` hook. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## License

MIT. Each plugin carries its own license field. `pi-redact`'s engine and
pattern set are ported from `opencode-redact` (MIT); `pi-jev-compact`'s decision
engine is vendored from `fast-jev-compaction` (MIT, tamaratran) — see
[`plugins/jev-compact/ATTRIBUTION.md`](plugins/jev-compact/ATTRIBUTION.md).
