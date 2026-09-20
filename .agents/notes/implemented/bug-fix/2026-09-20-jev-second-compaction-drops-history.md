# Agent Note: The second compaction dropped all prior history

Status: implemented

## Problem

pi builds a compaction's input in `prepareCompaction()`. When a session has
already been compacted once, that function walks back to the *previous*
compaction's `firstKeptEntryId` and only collects messages after it:

```js
boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
```

Everything older is deliberately excluded from `messagesToSummarize`, and the
earlier summary is handed back separately as `preparation.previousSummary`.
pi's own summarizer consumes it — `generateSummary` switches to
`UPDATE_SUMMARIZATION_PROMPT` and wraps the prior text in
`<previous-summary>…</previous-summary>`.

`pi-jev-compact` ignored `previousSummary` entirely and built its transcript from
`[...messagesToSummarize, ...turnPrefixMessages]`. So on the second and every
subsequent compaction, the summary it wrote described only the messages since
the last compaction and **silently forgot everything before it**.

The failure is invisible in the transcript. `appendCompaction()` succeeds, the
entry looks well-formed, `details.provider` is `jev-compact`, and the token
savings are real. The loss only shows up later, when the model no longer knows a
constraint the user stated hours ago. Measured on a synthetic second compaction:

```
BEFORE  summary 5,221 chars — contains "never edit src/generated"?  false
                            — contains "/v2/orders"?                 false
                            — contains "migration runs first"?      false
```

Every one of those was present in `previousSummary`.

A second, smaller leak sat in the same function. `toEngineMessages` recognised
only `user`, `assistant` and `toolResult`, and dropped every other role. But
pi's `convertToLlm` maps four more onto the user-text channel, so pi's default
summarizer would have kept them:

| role | what it carries |
| --- | --- |
| `bashExecution` | the command and output of a `!command` run |
| `custom` | an extension message created with `sendMessage` |
| `branchSummary` | the summary of a branch the session came back from |
| `compactionSummary` | a prior compaction summary |

Those are text, and text is exactly what this plugin promises never to discard.

## Decision

**`previousSummary` is folded back in as the leading message.** Before the
prune, the handler prepends a synthetic user message whose text is pi's own
framing plus the prior summary:

```
The conversation history before this point was compacted into the following
summary:

<previousSummary>
```

Three properties make this the right shape:

- It goes through the **same** channel as every other message, so the engine
  scores it, the serializer renders it, and the `MIN_REDUCTION` guard protects
  it like anything else.
- It is **user text**, which the engine structurally never drops. Had it been
  modelled as a tool result, a low `keepResult` would have deleted it.
- The wording matches pi's `COMPACTION_SUMMARY_PREFIX`, so the model sees the
  same framing it would have seen from the built-in summarizer.

**Every text-bearing role is now mapped, not dropped.** `toEngineMessages`
handles `bashExecution`, `custom`, `branchSummary`, `compactionSummary` and
`compactionSummary`, and defaults unknown roles to "keep the text" rather than
"discard it", because discarding is the failure this plugin exists to prevent.
`excludeFromContext` is the one deliberate exception: pi itself keeps those out
of context, so they must not be reintroduced.

The configuration was also made lazy while fixing this. `config()` and
`resolveApiKey()` now read the environment at the point of use instead of once
at module load. The eager read was a real defect: `/reload` re-runs the factory,
so a module-scope value stayed stale for the process lifetime, and the
compaction hook depended on `session_start` having already fired to populate a
module-level `apiKey`.

## Alternatives considered

**Append the prior summary after the pruned transcript.** Simpler, no synthetic
message. Rejected because it puts a hand-maintained block outside the engine's
model: it would bypass the reduction guard, could not be scored, and would sit
after the newest content, where a reader expects the *oldest* context.

**Pass `previousSummary` to Jev as part of the state only.** Tempting, since the
state is where Jev reads context. Rejected because the state is not what gets
serialized — the summary comes from `result.messages`. Jev would make better
decisions while the output still omitted the history. The text has to be a
message.

**Trust pi to prepend it.** pi only prepends `previousSummary` when *it*
generates the summary. An extension-provided `compaction.summary` replaces that
path entirely, so the responsibility is ours.

**Keep dropping unknown roles.** Defensible for an unknown future role whose
text is not meant for the model. Rejected because the default would be silent
data loss on the exact axis the plugin advertises, and the cost of keeping an
unwanted line is far lower than the cost of losing a constraint.

## Consequences

A second compaction now carries the full chain of prior summaries, so context
survives repeated compaction rather than degrading once per compaction.

The synthetic message occupies context budget and is counted in
`reductionRatio`, which is correct: it is real content the next window needs. It
is also plain text, so it is never a drop candidate.

`previousSummary` can itself be long (it is a prior summary of arbitrary size).
It is subject to the same `maxStateTokens` fitting as everything else, which
means a very large prior summary can be abridged *for the Jev state* while still
being preserved verbatim in the output.

Making the config lazy means each call re-reads six environment variables. That
is a handful of property lookups on a path that already makes a network call, so
the cost is noise.

## Verification

Tests live in `plugins/jev-compact/test/hook.test.ts` (the full extension, with
`globalThis.fetch` faked so the real client, retry wrapper, engine and
serializer all run) and `plugins/jev-compact/test/pi-adapter.test.ts` (role
mapping).

- `plugins/jev-compact/test/hook.test.ts::previousSummary is folded back into the summary`
- `plugins/jev-compact/test/hook.test.ts::the prior summary is sent to Jev, not merely appended`
- `plugins/jev-compact/test/pi-adapter.test.ts::non-conversational roles keep their text instead of being dropped`
- `plugins/jev-compact/test/pi-adapter.test.ts::a bashExecution excluded from context stays out`

Proved: reverted the `previousSummary` handling so the handler read only
`messagesToSummarize` → `previousSummary is folded back into the summary` failed
on all three probes (the generated-files constraint, the orders-endpoint path, and the
migration-order line), then restored and re-ran green. The role-mapping gap was proved the same
way, by restoring the three-role `switch` → `non-conversational roles keep their
text` failed on all four role probes. Also verified against the live System One
API: a second compaction with a `previousSummary` returned a 7,963-char summary
containing all three prior facts.
