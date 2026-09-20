# pi-redact

> Automatically redact API keys, tokens, passwords and secrets from every payload sent to a model — before it leaves your machine.

Part of the [pi-plugins](../../) workspace. A port of
[`opencode-redact`](https://github.com/meimingqi222/opencode-redact) to
[pi](https://pi.dev)'s extension API, with **112 built-in detection rules**
covering GitHub PAT, AWS keys, OpenAI/Anthropic API keys, Stripe tokens, JWT,
Slack webhooks, private keys, and more.

## Why this exists

When a coding agent reads a file that contains a live credential — `.env`, `~/.aws/credentials`, a Terraform state, a CI log — that secret is copied into the conversation and sent to whatever model provider you have configured. pi ships no redaction of its own.

pi-redact intercepts the payload right before the HTTP request is made and replaces recognized secrets with `[REDACTED:<pattern-id>]` placeholders.

## Install

From the workspace root:

```bash
pi install -l ./plugins/redact
```

Or drop it in globally as an extension directory:

```
~/.pi/agent/extensions/pi-redact/index.ts
```

The extension has no runtime dependencies beyond pi itself — the whole engine is self-contained TypeScript.

## Coverage

| Category | Examples |
|----------|----------|
| Git hosting | GitHub (PAT/OAuth/App/Fine-grained), GitLab, Bitbucket, Sourcegraph |
| Cloud | AWS (Access + Secret Key), GCP Service Account, Cloudflare, Heroku, Alibaba |
| AI/LLM | OpenAI (4 variants), Anthropic |
| Collaboration | Slack (6), Discord (3), LinkedIn, Twitch, Twitter, Facebook |
| Payments | Stripe, Flutterwave |
| Infrastructure | Docker config, JWT, npm, PyPI, RubyGems, Pulumi, Age, SendGrid |
| Monitoring | Grafana, New Relic, Databricks, Dynatrace |
| Other | HubSpot, Intercom, Mailchimp, Mailgun, Typeform, Todoist, Canva |
| Generic | `api-key`, `webhook-secret`, `password`, `sk-secret`, private keys |

See [`src/patterns.ts`](src/patterns.ts) for the complete, authoritative list.

## How it works

pi has two places where model input can be observed:

```
agent loop          context (AgentMessage[])  ──► context hook
                    │
provider call       final serialized payload  ──► before_provider_request hook
                    ▲
auto-compaction ────┘   (bypasses `context`)
branch summaries ───┘
```

Auto-compaction, branch summaries and overflow retries build their own prompt and call the model runtime directly, so they **never** pass through `context`. They do go through the same `streamFn`, and pi wraps that with `before_provider_request`.

pi-redact therefore treats `before_provider_request` as the primary gate and deep-walks the final payload. `context` and `tool_result` are defense in depth:

```
Provider request  →  before_provider_request  →  full payload deep-walked
Agent context     →  context                  →  message history deep-walked
Tool result       →  tool_result              →  content + details deep-walked
Command           →  /redact                  →  status / on / off / toggle
```

The walk is copy-on-write: unchanged branches keep their original reference, so provider payloads containing class instances, buffers or other special objects round-trip intact. Base64 image data is detected structurally and never rewritten.

Any failure inside the redactor is caught and logged to stderr; the request is passed through unmodified rather than blocked.

### Other extensions' outbound requests

The hooks above only see payloads pi itself sends. An extension that posts a
conversation to its **own** backend never passes through them — so with
[`pi-jev-compact`](../jev-compact) installed, a secret was redacted from the
model request and uploaded to TypeSafe in the clear in the same turn.

pi-redact therefore also publishes a versioned redaction service on pi's shared
event bus (`pi.events`, channel `pi-redact:service`). A consumer calls
`redactJson` on its outbound payload and gets the exact same engine and rule set:

```
pi-redact  ──emit──►  pi-redact:service  { version, redactJson, redactString }
                                        ◄──on────  consumer
                       ◄──emit────────  pi-redact:service-request  (late consumer)
```

The service is a **live view**: it honours `/redact off`, so a consumer does not
track pause state itself. The contract is validated at runtime (`version`), and
load order does not matter — a consumer that hears no announcement asks for one,
so the handshake closes whichever plugin loads second. pi-jev-compact is the
first consumer; the bridge is described in its README and in
[`.agents/notes`](../../.agents/notes/implemented/bug-fix/2026-09-20-redact-provider-gap.md).

This does not make the plugins depend on each other. `pi-redact` works alone,
`pi-jev-compact` works alone, and the bus contract is the only link.

## Configuration

Everything is optional. Defaults redact on every request.

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_REDACT` | `true` | Set to `false` to disable the extension entirely |
| `PI_REDACT_CONFIG` | `~/.pi/agent/redact.json` | Path to a JSON config file |
| `PI_REDACT_PATTERNS` | – | Comma-separated pattern IDs to **disable** |
| `PI_REDACT_PATHS` | – | Extra path-based redaction, e.g. `credentials.password,token` |
| `PI_REDACT_TOOL_RESULTS` | `true` | Set to `false` to keep raw tool results in the session |
| `PI_REDACT_TOOL_INPUTS` | `false` | Redact tool **arguments** too (see caveat below) |
| `PI_REDACT_USER_INPUT` | `false` | Also rewrite your stored prompt |
| `PI_REDACT_CACHE_MB` | `32` | Redaction cache budget in megabytes |
| `PI_REDACT_NOTIFY` | `true` | Show the startup notification |

### Config file

```jsonc
// ~/.pi/agent/redact.json
{
  "disabledPatterns": ["gocardless-api-token"],
  "extraPatterns": [
    {
      "id": "my-company-key",
      "category": "custom",
      "title": "My Company API Key",
      "pattern": "(mykey-[a-z0-9]{32})",
      "keywords": ["mykey-"]
    }
  ],
  "redactPaths": ["credentials.password", "config.token"],
  "pathCensor": "[REDACTED]",
  "cacheBytes": 33554432
}
```

### Caveat: `PI_REDACT_TOOL_INPUTS`

pi applies `tool_call` input mutations to the **real execution**. Redacting arguments would therefore corrupt commands that legitimately need a credential, for example:

```bash
git push https://x-access-token:ghp_…@github.com/org/repo
```

Because of that, this switch defaults to `off`. Prefer the default (redact only what is sent to the model).

## Command

```
/redact              # status
/redact status       # status
/redact on           # enable
/redact off          # pause (secrets will be sent until re-enabled)
/redact toggle
/redact patterns     # list every active rule
/redact test <text>  # dry-run the engine (never echoes the raw input)
```

Pause state is persisted in the session and restored on resume.

## Performance

Redaction runs on the critical path of every model request, so it is written to be effectively free relative to the network.

Measured on this machine with `bun bench/bench.ts` (112 patterns):

| Payload | Cold pass | Warm pass |
|---------|-----------|-----------|
| 18 KB (4 messages) | 0.4 ms | 0.1 ms |
| 1.1 MB (300 messages) | 1.5 ms | 0.9 ms |
| 9 MB (2500 messages) | 8.4 ms | 5.4 ms |

Single-string throughput is ~110 MB/s cold. Repeat passes are ~1800x faster on large strings because the previous turn's history is served from cache.

### Design

- **Keyword pre-filter.** Each pattern is gated by cheap `String.includes` checks. On ordinary code and prose, 0 of 112 regexes run. Profiling with `bench/profile-patterns.ts` confirms the filter is what keeps the cost linear.
- **One `toLowerCase` per string.** All case-insensitive patterns share a single lowercase snapshot, invalidated only when a replacement actually changes the text.
- **Byte-bounded LRU cache.** 32 MB budget, evicted oldest-first. A single entry larger than the budget is skipped rather than clearing the cache. Previously the cache was entry-count bounded with a 512 KB per-entry cap, which silently disabled caching for exactly the large-file-read case that benefits most.
- **Copy-on-write deep walk.** Untouched branches keep their original reference; a payload with no secrets allocates nothing.
- **Failure never blocks.** Any engine error is logged to stderr and the request is passed through unmodified.

Perf regressions are guarded by `test/perf.test.ts`, which asserts on cache behaviour and `toLowerCase` call counts rather than wall-clock time. Each guard was verified to fail when its corresponding bug is reintroduced.

Correctness regressions from the engine audit are guarded by
`test/engine.regression.test.ts` and recorded in the workspace regression notes
under `.agents/notes/implemented/bug-fix/`:

- `redact-cycle-guard` — cyclic payloads must not overflow the stack
- `redact-capture-offsets` — censor the capture group, not its first textual match
- `redact-zero-width-match` — an empty-matching rule must terminate and stay inert
- `redact-provider-gap` — the service published for other extensions must be
  announced, re-announced on request, and honoured by consumers
- `fixture-secrets-block-push` — fixture values must not appear as contiguous
  secret-shaped literals, or GitHub push protection blocks the push

## Development

Run from this directory (`plugins/redact`), or from the workspace root with
`bun run --filter pi-redact <script>`:

```bash
bun test              # 67 tests
bun run typecheck     # tsc --noEmit
bun bench/bench.ts            # payload + cache benchmarks
bun bench/profile-patterns.ts # which keyword filters pass on clean text
```

Layout:

```
src/
  index.ts       pi extension: hooks, config, /redact command, service announcement
  service.ts     the versioned contract other extensions consume over pi.events
  pi-bridge.ts   copy-on-write deep redaction for pi payload shapes
  engine.ts      pattern compiler, LRU cache, string/deep/path redaction (shared)
  patterns.ts    112 built-in secret rules (shared)
test/
  index.test.ts            extension behaviour against a mock pi API
  pi-bridge.test.ts        payload walking, binary preservation, cycles
  patterns.test.ts         built-in rule smoke tests
  engine.regression.test.ts correctness under the perf optimisations
  perf.test.ts             hot-path regression guards
  fixtures.ts              credential-shaped dummies, split so no literal matches
  no-secrets.test.ts       the guard: no secret-shaped literal in the source
bench/
  bench.ts                 honest payload/cache benchmarks
  profile-patterns.ts      keyword pre-filter effectiveness
```

`fixtures.ts` splits each dummy credential across two string halves so no
contiguous secret-shaped literal exists in the source; `no-secrets.test.ts`
enforces it. Keep the split — a contiguous literal makes scanners flag the repo
and makes GitHub refuse a push.

## License

MIT. Engine and pattern set ported from `opencode-redact` (MIT).
