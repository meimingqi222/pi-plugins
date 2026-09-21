# pi-jev-compact

> Compaction that **deletes** stale tool calls instead of **rewriting** your
> conversation into a summary. User and assistant text is never touched.

Part of the [pi-plugins](../../) workspace.

pi's built-in compaction asks an LLM to summarize old turns. A summary is lossy:
a file path, an exact error, or a constraint can vanish even when it matters
later. This extension never rewrites anything. For every tool call outside the
pinned newest messages, it asks [Jev](https://typesafe.ai) (TypeSafe's System
One model) two questions:

1. should the **call** stay? (knowing it was made, with its input, still matters)
2. should the **result** stay verbatim? (its contents are still needed, and
   re-running the tool would not do)

Then it keeps the survivors **verbatim**, drops or truncates the rest, and
serializes the result into the compaction summary. No text is paraphrased, ever.

## Install

```bash
pi install -l ./plugins/jev-compact
```

Requires a TypeSafe API key. Any of these works;
`auth.json` and the config file are read directly, so no shell setup is needed
(the key is read on each use, so `/reload` picks up a change):

**1. `auth.json`** — the file pi's `/login` writes. Add a plugin-owned entry:

```jsonc
// ~/.pi/agent/auth.json
{
  "anthropic":       { "type": "api_key", "key": "sk-ant-..." },
  "typesafe":        { "type": "api_key", "key": "<your key>" }
}
```

This is safe in both directions: a stored credential is `{ type, key }`, the
same shape pi writes for its own providers, and pi's write path re-serializes
the whole object, so a foreign key survives `/login` and `/logout`.

> Note: `ctx.modelRegistry.getApiKeyForProvider("typesafe")` would **not** find
> this — the registry only resolves registered *model* providers. The plugin
> reads the file directly instead, which is why an `auth.json` entry works here
> but not through the registry API.

**2. The plugin's own config file** — `<agent dir>/jev-compact.json`:

```jsonc
{ "apiKey": "<your key>" }
```

**3. The environment** — best for CI, and the highest priority:

```bash
# bash / zsh
export TYPESAFE_API_KEY=...

# Windows, persistent (reopen the terminal)
setx TYPESAFE_API_KEY "..."
```

Precedence is **environment → `jev-compact.json` → `auth.json`**, so an explicit
export always overrides a stored value.

A caveat for the environment route specifically: shell rc files are only read by
*interactive* shells, so a pi launched from a GUI (or by another app) will not
see an export from `~/.zshrc`. `auth.json` and the config file do not have that
problem, which is part of why they are supported.

## Architecture note: why a serializer

pi's `session_before_compact` can only return `{ summary: string }` — it cannot
replace the message list (`CompactionResult` has no `messages` field). So the
pipeline here is **prune → serialize**, not prune → replace:

```
compact: Jev decides what dies
   ↓
result.messages: the survivors, verbatim
   ↓
serializeEngineMessages(): reproduce them exactly, marker by marker
   ↓
{ compaction: { summary } }: pi stores that as the summary
```

The renderer lives in `src/serialize.ts` together with `serializedChars()`, the
measurement used for the reduction ratio. They share a module because the ratio
decides whether a compaction is used at all (`JEV_COMPACT_MIN_REDUCTION`), so it
must describe the string that will actually be produced. Keeping the two apart
let them drift — see
[`2026-09-20-jev-serializer-drift.md`](../../.agents/notes/implemented/bug-fix/2026-09-20-jev-serializer-drift.md).

This matches how `fast-jev-compaction` works as a Claude Code hook. The practical
consequence: **kept tool results are not clipped**. pi's own serializer truncates
every result at 2000 characters regardless of value; this one reproduces a
result Jev chose to keep in full.

### Dropping is skipped when it would grow the transcript

A `drop_call` keeps the call as a one-line trace and replaces its output with a
~72-character note. When the output is shorter than the note, discarding makes
the summary **larger** — measured at +47 characters for a 10-character output.
Jev answers "is this still needed", not "is this bigger than the note", so the
decision is made in code: the call is kept when
`keptCallChars <= droppedCallChars`. In a real session this preserved 14 of 50
outputs under 120 characters that would otherwise have grown the summary.

## Secrets are redacted before they reach TypeSafe

This extension uploads a conversation to a third party, so it has to answer a
question pi's own hooks do not: what leaves the machine here?

[`pi-redact`](../redact) gates the payload sent to your **model provider**, but
this plugin posts to TypeSafe's System One endpoint with its own `fetch`, which
never passes through those hooks. Without a bridge the same secret would be
redacted from the model request and uploaded to TypeSafe in the clear in the same
turn.

So when pi-redact is installed, this extension subscribes to the redaction
service it publishes on pi's shared event bus (`pi.events`) and runs that same
engine over the state and questions immediately before upload:

```
prune → serialize          (local)
   ↓
withRedaction(asker)       ← the engine runs here, at the transport edge
   ↓
withRetry → JevClient → fetch → api.typesafe.ai
```

Details worth knowing:

- **Wrapping outside the retry loop** means every attempt reuses the one redacted
  payload. Re-redacting per retry is wasted work, and re-reading the raw input on
  a retry would make that the single request that leaks.
- **Redaction fails closed.** If the redactor throws, the ask is aborted and the
  compaction falls back to pi's summary. Sending the secret is the one outcome
  this bridge exists to prevent.
- **Redaction preserves object keys**, so Jev's answers still map back to their
  questions by name.
- **Discovery works in either load order.** pi has no "wait for extension X"
  primitive and no priority field, so a consumer that hears no announcement asks
  for one and pi-redact re-announces.
- **The surfaces that actually leak** are user messages, assistant text, and tool
  **arguments**. A tool result's contents are replaced by `ok, N chars (omitted)`
  in the Jev state, so they never reach TypeSafe in the first place.

Neither plugin depends on the other. This extension works standalone (the asker
is returned untouched when no redaction service is present), and the startup
notice says which state is active:

```
Jev compact: pi-redact detected — Jev payloads are redacted before upload
Jev compact: pi-redact not detected — Jev payloads are sent unredacted
```

See [`2026-09-20-redact-provider-gap.md`](../../.agents/notes/implemented/bug-fix/2026-09-20-redact-provider-gap.md)
for why the bus was chosen over importing pi-redact's engine.

## Repeated compaction

A second compaction does not receive the older messages: pi excludes everything
before the previous compaction's `firstKeptEntryId` and hands the earlier
summary back as `preparation.previousSummary`. The extension folds that summary
back in as the leading message, so context accumulates across compactions
instead of being forgotten on the second one. Because it enters as *user text*,
the engine can never drop it.

The fold-in is **idempotent**. pi hands back the summary verbatim — the string
this extension returned — so that string already begins with `[User]: ` plus the
framing. `stripCompactionFrame()` removes that unit before it is re-added;
without it, one more layer nests on every compaction, without bound (a real
session reached two by its third Jev compaction). The strip matches only the
complete marker-plus-frame unit, so the `[User]:` line that legitimately begins a
transcript survives, and summaries already nested by an earlier version are
unwound rather than extended.

The same fold-in repairs **discard notes inherited from an earlier version**.
Those were emitted as a separate `[Tool result]:` part, which made them text that
Jev can never delete, so each compaction copied them forward at full size. Only
the exact note, immediately after a call line naming the same tool, is merged
into the inline marker; anything else is left untouched.

One limitation follows from pi's string-only summary contract: tool calls already
serialized into `previousSummary` are plain text on the next pass, so Jev does
not reconsider their results individually. Only original messages crossing the
new compaction boundary remain structured candidates. The hook also receives raw
`branchEntries`, but replaying those directly would resurrect output deliberately
dropped by earlier passes; safely changing this requires a versioned structured
snapshot rather than parsing the human-readable summary.

## Long conversations are windowed, not shrunk

Jev's token limit bounds **one request's state**, not the conversation. So a long
session is split into contiguous windows of at most `JEV_COMPACT_MAX_STATE_TOKENS`,
and every tool call is judged inside the window that contains it.

This replaced an earlier design that shrank the whole conversation into a single
budget. That approach failed in the way that matters most — silently. Measured on
a synthetic long session:

| calls | old: one shrunken state | new: windows |
| ----- | ----------------------- | ------------ |
| 400 | 29,992 tok, `old calls compacted` | 2 windows, ~28k each, `full` |
| 800 | 15,544 tok, `old calls merged` | 3 windows, ~28k each, `full` |
| 1600 | **747 tok, `old traces dropped`** | 5 windows, ~28k each, `full` |

At 1600 calls the old design dropped *every* tool trace and still asked Jev to
decide all 1600 of them: the model was judging calls it could no longer see, and
nothing in the output said so. Windowing keeps each call beside its own context.

Two details make a window usable:

- **The first message rides in every window.** It holds the standing instruction
  (`never edit src/generated`), so a decision in window 5 is made with the same
  constraint as one in window 1.
- **Each window repeats a few entries from the previous one**
  (`DEFAULT_CHUNK_OVERLAP`). Without it, the first call of a window would be
  judged with no preceding turn — exactly the context that explains it. The
  overlap is *reserved* during packing, not dropped when the window fills up;
  a full window is the normal case, so dropping overlap first would mean it never
  applied when it was needed. The reservation is itself bounded by the window's
  own first body entry: overlap entries are taken newest-first within
  `budget - preamble - firstBodyEntry`, so a run of large messages shortens the
  overlap rather than overflowing the window. See
  [`2026-09-20-jev-window-overlap-overflow.md`](../../.agents/notes/implemented/bug-fix/2026-09-20-jev-window-overlap-overflow.md).

A window that still does not fit falls back to the staged shrinker, and any call
left without an answer is **kept**. Throwing is reserved for a single message
larger than an entire window.

### Why the window ceiling is 28k, not 32k

Jev's documented limit is 32k for `state` plus the longest question
([docs.typesafe.ai/models](https://docs.typesafe.ai/models)). The ceiling is
enforced against `estimateTokens`, which has no tokenizer and is
content-dependent. Measured against Jev's reported `input_tokens`:

| content | estimated | actual | ratio |
| ------- | --------- | ------ | ----- |
| English prose | 2,978 | 3,278 | 1.10 |
| Mixed Chinese + identifiers | 4,163 | 4,627 | 1.11 |
| Chinese | 5,543 | 4,927 | 0.89 (safe) |
| Code | 6,308 | 4,277 | 0.68 (safe) |

A 32k window would therefore be a ~35k request and be rejected. 28k leaves ~12%
headroom, enough for the worst observed error.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | The Jev/System One key. Highest priority, but not the only source; see [Install](#install). |
| `JEV_COMPACT` | `true` | Set `false` to disable the extension. |
| `JEV_COMPACT_MODEL` | `jev-latest` | Jev model name. |
| `JEV_COMPACT_THRESHOLD` | `0.5` | Keep probability cutoff. Lower keeps more; higher discards more. Clamped to 0–1. |
| `JEV_COMPACT_PRESERVE_RECENT` | `6` | Newest messages never touched. |
| `JEV_COMPACT_TRUNCATE_HEAD` | `300` | Characters kept of a dropped result. |
| `JEV_COMPACT_MAX_STATE_TOKENS` | `28000` | Size of one state **window**. A longer conversation is split into several. |
| `JEV_COMPACT_MAX_REQUEST_TOKENS` | `64000` | Ceiling for state plus one batch of questions (Jev's full budget). |
| `JEV_COMPACT_MAX_CONCURRENCY` | `4` | Maximum simultaneous Jev requests across all windows and question batches. |
| `JEV_COMPACT_BASE_URL` | TypeSafe endpoint | Override the API base. |
| `JEV_COMPACT_MIN_REDUCTION` | `0.3` | Below this reduction, fall back to pi's summary. |
| `JEV_COMPACT_MAX_ATTEMPTS` | `4` | Total transport attempts per ask (1 try + 3 retries). |
| `JEV_COMPACT_RETRY_BASE_MS` | `300` | First retry backoff; doubles per attempt, capped at 4s. |

Every failure — missing key, Jev error, unfittable state, or too little
reduction — falls back to pi's own summary rather than losing the turn.

### Why "only N% removable" happens

On a **second** compaction, pi sends only the messages added since the previous
one, plus the previous summary as `previousSummary`. That summary is pure text and
is folded in as the first user message, so it is never a candidate for deletion.
The ratio is set by how much of the input is deletable tool output, because text
is never touched. Measured with every result dropped:

| undeletable text | tool-output share | reduction |
| ---------------- | ----------------- | --------- |
| 200,000 chars | 16.7% | 9.1% |
| 100,000 chars | 44.4% | 28.4% |
| 50,000 chars | 61.5% | 43.9% |
| 20,000 chars | 80.0% | 65.1% |

So a text-dominated input lands below `JEV_COMPACT_MIN_REDUCTION` and defers to
pi, which rewrites the whole summary and actually shrinks it. This is the intended
behaviour, not a failure: a Jev pass there would swap a structured summary for a
near-identical verbatim transcript.

Jev's answers are sharply bimodal in practice — across 354 real decisions the
median `keepResult` was 0.140 and the maximum 0.200, none reaching the 0.5 keep
cutoff — so the ratio is decided by the input's composition more than by Jev's
judgement. Read the threshold as "is there enough deletable output here to be
worth it".

### Retry behavior

Transport faults are retried; configuration problems are not. A request was
observed failing with `unknown certificate verification error` and then
succeeding on eight consecutive repeats, so a single TLS blip would otherwise
silently downgrade the next context window to pi's lossy summary.

| Retried | Not retried |
| --- | --- |
| `certificate`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_*`, `fetch failed`, `socket hang up`, `premature close`, malformed JSON | `400`, `401`, `403`, `404`, `422`, missing/invalid answers, missing API key |
| `408`, `425`, `429`, `500`, `502`, `503`, `504` | |

The whole `error.cause` chain is inspected, because Node reports `fetch failed`
at the top and the real reason one level down. Each retry emits a notification.

## The three decisions

| `keepResult` | `keepCall` | Action |
| --- | --- | --- |
| ≥ threshold | — | keep the call **and** its result in full |
| < threshold | ≥ threshold | keep the call, truncate the result to `truncateHeadChars` + a note |
| < threshold | < threshold | **keep the call as a trace**, discard its output |

Calls in the first message and the newest `JEV_COMPACT_PRESERVE_RECENT` messages
are pinned and never asked about.

### Why a dropped call keeps a trace

Upstream `fast-jev-compaction` removes a dropped call entirely. For a coding
agent that is the wrong trade, and it shows up in two ways on a real session:

- **34% of assistant messages are call-only** (no text). Erasing a call erases
  the whole message, leaving no record that anything happened.
- The remaining messages keep their prose — *"I'll look at the config"* — while
  the call that says **which** file is gone.

The output is re-derivable only if the model knows what to re-run, so a dropped
call keeps its own line and is **marked in place**:

```
[Assistant tool calls]: read(path="src/config/defaults.ts") [output discarded; re-run to restore]
```

The marker rides on a line that has to exist anyway, and it deliberately emits
**no** `[Tool result]:` part. That absence is the signal: a call followed by a
result still has its output, a marked call does not. (A separate
`[Tool result]: (output discarded …)` note was the earlier design. It cost two
lines per call and, being text, was inherited unchanged by every later
compaction — 328 notes, 11% of a real summary, 259 of them inherited — which is
why it was folded into the call line.)

The trace is **clipped**, because a trace is not automatically small: `write`
and `edit` carry the whole file body in their arguments, so rendering them in
full would reproduce exactly the bytes just discarded. Each argument value is
clipped to 200 chars and each call to 600, with the elided size reported:

```
[Assistant tool calls]: write(content="# pi-plugins

A workspace of…(12802 more), path="README.md") [output discarded; re-run to restore]
```

Values are clipped individually rather than cutting the rendered string, so
**keys always survive** — `path=` for `read`/`write`, `command=` for `bash`. A
naive prefix cut would keep `content="…"` and lose the file path.

On a real 361-call session this keeps **every** call traceable (361/361 carry a
path or command) while the summary shrinks from 823 KB to 178 KB.

## Measuring quality

The reason this plugin exists is the claim "deleting beats summarizing". That
claim is testable, so it is tested:

```bash
TYPESAFE_API_KEY=... MORPH_API_KEY=... bun bench/compare-quality.ts
```

The bench builds a transcript with **planted facts** — constraints, an exact
error, decisions — buried in the *middle* of long prose blocks, interleaved with
bulky superseded tool output. Then it scores each strategy on how many facts
survived at what reduction:

```
  strategy                      chars  ~tokens  reduc   critical       important
  identity                    152,841  ~38,211    -1%   9/9            4/4
  head-keep 30%                46,739  ~11,685    69%   4/9            1/4
  proportional 30%             50,914  ~12,729    66%   2/9            3/4
  drop-largest 30%            107,132  ~26,783    29%   9/9            4/4
  jev-compact                  ...
  morph (ratio 0.7)           106,906  ~26,727    29%   8/9            4/4
  morph (ratio 0.5)            77,256  ~19,314    49%   8/9            4/4
  morph (ratio 0.3)            47,246  ~11,812    69%   7/9            4/4
```

Two findings worth noting, both reproducible:

- **Positional filters fail on mid-prose facts.** `head-keep` and
  `proportional` lose most critical facts, because the facts are in the middle.
- **Morph loses user-message facts at aggressive ratios.** At ratio 0.3 it drops
  `test-command` and `file-migration` — both stated by the *user*, both
  load-bearing. Morph filters lines by position/budget; it does not know a
  constraint from a log line. This extension structurally cannot drop text.

`MORPH_SWEEP=0.9,0.5,0.3` overrides the ratio sweep. Either key may be omitted;
that strategy is skipped.

### On a real session

Synthetic fixtures can be tuned until they prove a point, so the stronger test
replays an actual pi session. The one below compacted 570 messages / 307 tool
calls, of which **97.2% of the bytes were tool output and 2.8% text**:

```bash
TYPESAFE_API_KEY=... MORPH_API_KEY=...   bun bench/replay-session.ts <session.jsonl>
```

It scores **text preservation** — for every user/assistant text message, is a
60-char probe of it still present? Text is the only thing a compaction may not
legitimately discard; tool output is re-derivable.

```
  strategy                     chars  reduc   text kept    user
  identity                   563,966     0%   173/173      7/7
  jev (threshold 0.2)        278,823    52%   173/173      7/7   1.6s
  jev (threshold 0.5)         24,808    96%   173/173      7/7   0.8s
  morph (ratio 0.9)          515,401     9%   172/173      7/7   6.3s
  morph (ratio 0.5)          313,137    44%    80/173      3/7   4.9s
  morph (ratio 0.3)          191,971    66%    31/173      0/7   4.7s
```

At matched reduction the difference is not marginal:

- Jev reaches 100% text preservation at **52%** reduction.
- Morph needs ratio 0.9 — **9%** reduction, i.e. almost no compaction — to get
  close, and at 66% it has discarded **every user message** (0/7).

One caveat worth stating plainly: Jev's default threshold is effectively "drop
almost all tool output". The `keepResult` probabilities cluster low
(median 0.140, max 0.200 over 354 real decisions, none reaching the 0.5 cutoff),
so thresholds from 0.5 to 0.95 behave identically. That is upstream behaviour,
and it is the right trade for re-derivable output — but lower
`JEV_COMPACT_THRESHOLD` if you need specific results retained.

## Development

```bash
bun test              # 133 tests, no network
bun run typecheck
bun bench/compare-quality.ts
```

Layout:

```
src/
  index.ts        pi extension: session_before_compact hook, config
  pi-adapter.ts   pi AgentMessage ↔ engine Message, verbatim serializer
  retry.ts        transport-fault retry wrapper around JevAsker
  redact.ts       consumes pi-redact's service so the TypeSafe payload is redacted
  jev/
    types.ts      message/question/answer shapes
    state.ts      Jev state assembly + staged shrink
    request.ts    System One HTTP contract
    client.ts     JevClient
    compact.ts    the decision core
test/
  engine.test.ts          decision thresholds, text preservation, pinning, failures
  pi-adapter.test.ts      the pi bridge (guards the call/result pairing bug)
  retry.test.ts           retry classification, backoff schedule, no-retry cases
  hook.test.ts            the extension end-to-end with a faked fetch: prior
                          summaries, fallbacks, retry, key resolution
  redact-bridge.test.ts   the bus handshake, fail-closed, standalone behaviour
  redact-integration.test.ts  both real plugins on one bus: a secret in user
                          text / assistant text / tool args never reaches TypeSafe
  fake-jev.ts             scripted asker, so tests never hit the network
bench/
  compare-quality.ts planted-fact comparison vs Morph (synthetic)
  replay-session.ts  replay a REAL pi session through both strategies
  fixture.ts         the labelled transcript
  morph-client.ts    minimal Morph Compact client
```

## Regression notes

Behaviors fixed after being observed in real use, each pinned by tests:

- `jev-transient-retry` — a TLS blip must not silently downgrade compaction
- `jev-second-compaction-drops-history` — the second compaction must not forget
  everything before the first one
- `redact-provider-gap` — the TypeSafe upload must be redacted, not just the
  provider payload, guarded in `test/redact-integration.test.ts`
- the adapter's call/result pairing — guarded in `test/pi-adapter.test.ts`,
  where a partial fix compiled and passed every engine test while compacting
  nothing in real use

All three were silent: the compaction still "succeeded" and wrote a
well-formed entry, so nothing in the transcript revealed the loss.

## License

MIT. The decision engine is vendored from
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) v0.2.0
(MIT, tamaratran) — see [ATTRIBUTION.md](ATTRIBUTION.md).
