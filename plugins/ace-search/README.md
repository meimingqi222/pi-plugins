# pi-ace-search

Semantic codebase retrieval for pi, backed by the same Augment **ACE** index that
`acemcp-go` uses. Ships a CLI first, then a pi tool: `ace_codebase_search`.

Retrieval quality is why this exists. The two questions this was built against
were both answered better by ACE than by a local search tool, but the client it
came from (`acemcp-go`) was slow enough on a cold project to look hung. This
plugin keeps the index acemcp built and removes the waiting.

## Install

```bash
pi install -l ./plugins/ace-search
```

Requires an ACE endpoint and token. Both are read from `~/.acemcp/settings.toml`,
the same file `acemcp` uses:

```toml
BASE_URL = "https://<your-endpoint>/"
TOKEN = "<token>"
```

Every value can be overridden: `PI_ACE_BASE_URL`, `PI_ACE_TOKEN`,
`PI_ACE_DATA_DIR`, `PI_ACE_INDEX`, `PI_ACE_BATCH_SIZE`, `PI_ACE_CONCURRENCY`,
`PI_ACE_MAX_LINES_PER_BLOB`, `PI_ACE_LOG_LEVEL`. Set `PI_ACE_ENABLED=false` to
load the extension without exposing the tool.

## Why it is fast, and where the time goes

A cold search must upload the project before anything can be retrieved. On a
4.4k-file repository that is 6031 chunks, and `acemcp` spent **68s** uploading
them followed by up to **60s** of blocking index polling. Nothing is printed
until the whole call returns, so it reads as a hang.

This client removes each term:

| | acemcp-go | pi-ace-search |
| --- | --- | --- |
| Upload concurrency | hard-coded 4 | configurable, default 12 |
| Upload cancellation | `http.NewRequest`, no context — keeps running after a cancel | honours the tool's `AbortSignal` |
| Index polling | always, up to 60s, blocking | off unless `waitForIndex` |
| Progress | nothing until the end | streamed per phase |
| Re-hash on a warm run | n/a | ~0.6–1.5s |

Measured here, warm: **~5–7s total**, of which ~5s is the server's own retrieval.

### The cache is the whole point

Blob names and hashes are computed exactly as `acemcp` computes them —
`sha256(chunkName + chunkContent)`, `#chunk{N}of{TOTAL}` naming, 300-line chunks,
1 MiB file cap, no-newline minified-file skip. All 4428 files / 6031 hashes of
this workspace were verified byte-identical to acemcp's cache, so a project
`acemcp` already indexed uploads **nothing** on first use.

`acemcp`'s manifest is read but never written; this client keeps its own index
beside it, atomically. Two processes writing one manifest was one of the problems
being fixed.

## CLI

```bash
# Human-readable context
bun run src/cli.ts search ~/code/ZCode "How is provider model metadata resolved?"

# Just the cited paths — for diffing one engine against another
bun run src/cli.ts paths ~/code/ZCode "How is provider model metadata resolved?" | sort

# Machine-readable, with per-phase timings
bun run src/cli.ts search ~/code/ZCode "..." --json
```

`--stats` (on by default for `search`) prints per-phase timings to stderr. `--wait`
enables the index poll; `--timeout` sets an overall deadline.

## Accuracy — and its limits

`bench/accuracy.ts` scores recall against hand-judged ground truth, over N
repetitions:

```bash
bun run bench/accuracy.ts --runs 5
```

Two findings worth knowing before trusting any single result:

1. **Retrieval is not deterministic.** Three identical runs of the same query
   cited different file sets. Any single-run comparison between engines is
   therefore unsound — including the comparison that motivated this plugin.
   The benchmark reports the worst run alongside the mean for that reason.

2. **Recall depends heavily on the cutoff.** Measured over 5 runs on this
   workspace:

   | query | @1 | @3 | @5 | @10 | union | n |
   | --- | --- | --- | --- | --- | --- | --- |
   | BYOK model metadata matching | 0% | 17% | 50% | 83% | 100% | 10 |
   | model metadata resolution | 0% | 0% | 17% | 33% | 67% | 15 |

   Read as: the right file is usually *somewhere* in ~10–15 results, rarely
   first. For the first query the top-10 list contained a judged-relevant file
   in every run and the union over runs reached 100%; for the second, two
   relevant files were never returned at all.

   The benchmark also carries the local search tool's observed output for the
   same queries. That row is n=1 and recorded by hand — it is an anecdote with a
   number attached, not a sampled result, and is labelled `*` in the output.

Neither engine alone was sufficient for the original question: the answer needed
code from `packages/provider/src/config/model-config.ts`, which ACE reached only
in some runs, plus the JSON rule table, which had to be read directly. Treat both
as *ranked suggestions*.

## As a pi tool

`ace_codebase_search` takes `query` (a full natural-language question, not
keywords), an optional `projectRoot` (defaults to the session cwd) and an
optional `waitForIndex`.

It is registered **alongside** `warpgrep_codebase_search` rather than replacing
it: given the non-determinism above, letting the model cross-check two rankings
is more useful than committing to one. Per-phase timings are included in the
result so a slow first search is attributable from the transcript.

## Privacy

This uploads source to a third-party ACE endpoint. `acemcp` already does the
same, and it reuses that index, so nothing new leaves the machine — but it is
worth stating plainly, and it is why `PI_ACE_ENABLED=false` exists.

## Architecture

```
src/
  config.ts       settings.toml parsing + env overrides
  client.ts       the four ACE endpoints; hash-vs-name identity rules
  walk.ts         workspace walker, exclude matcher, chunker
  index-store.ts  acemcp cache reader + own atomic index
  search.ts       hash → upload missing → retrieve, with phase timings
  format.ts       shared rendering for CLI and tool
  cli.ts          CLI harness
  index.ts        pi extension / tool registration
bench/accuracy.ts recall benchmark against judged ground truth
```

Blob identity is asymmetric and easy to get wrong: `/batch-upload` keys on the
blob **name**, while `/find-missing` and `/agents/codebase-retrieval` key on the
blob **hash**. Sending the wrong one is a 400. See
[`.agents/notes`](../../.agents/notes/implemented/bug-fix/2026-09-21-ace-blob-identity.md).

## Development

```bash
bun test
bun run typecheck
bun run bench/accuracy.ts --runs 3
```

`bun test` never touches the network: every client test stubs `fetch`, and
`runAceSearch` accepts an injected client.
