# Attribution

`pi-jev-compact` vendors its decision engine from
[`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) v0.2.0
by tamaratran, MIT licensed.

Vendored files (kept close to the original so diffs against upstream stay
readable):

| File | Origin |
| --- | --- |
| `src/jev/types.ts` | `src/types.ts` |
| `src/jev/state.ts` | `src/state.ts` |
| `src/jev/request.ts` | `src/request.ts` |
| `src/jev/client.ts` | `src/client.ts` |
| `src/jev/compact.ts` | `src/compact.ts` |

Why vendored rather than depended on: `fast-jev-compaction` is not published to
npm, and a pi extension must be installable from a single directory. Import
specifiers were rewritten from `.js` to `.ts` and the `messages.ts` convenience
wrapper was dropped, but the algorithm, option names, defaults, and error
behaviour are unchanged.

Deliberate divergence from upstream:

| Behaviour | Upstream | Here |
| --- | --- | --- |
| `drop_call` | removes the call **and** its result entirely | keeps the call as a single labelled trace, discards only the output |

The reason is in the README: 34% of assistant messages in a real session are
call-only, so erasing a call erases the message and loses the file path that
would make the output re-obtainable. Everything else — thresholds, pinning,
state fitting, batching, the three-way decision — is unchanged.

New in this plugin (not from upstream):

| File | What it adds |
| --- | --- |
| `src/pi-adapter.ts` | pi `AgentMessage` ↔ engine `Message` conversion, plus the verbatim serializer |
| `src/index.ts` | the `session_before_compact` hook, config, notifications |
| `bench/compare-quality.ts` | the planted-fact quality comparison |
| `bench/fixture.ts` | the labelled transcript the comparison scores against |
| `bench/morph-client.ts` | a minimal Morph Compact client for the comparison |
| `src/retry.ts` | transport-fault retry wrapper around `JevAsker` |

The Jev decision model itself is TypeSafe's; this plugin only decides *what to
ask*, not how to answer it.
