# Agent Note: Jev asks must retry transport faults

Status: implemented

## Problem

`pi-jev-compact` asked Jev exactly once per compaction. A request that failed
for any reason made `compact()` throw, and the `session_before_compact` handler
returned `undefined`, which tells pi to fall back to its own LLM summary.

The trigger is not hypothetical. A real API key produced:

```
unknown certificate verification error
```

on the first call, and then returned HTTP 200 on eight consecutive immediate
repeats of the same request. The endpoint was reachable and the key was valid
(`api.typesafe.ai` answers a bogus key with 401, not a TLS error, and the real
key succeeded 8/8 on the retry loop). So a small fraction of requests fail at
the TLS layer and succeed if simply asked again.

The damage is disproportionate to the cause. Compaction still *happens* — pi's
fallback is not an error state, it is a silent downgrade. The user gets a
rewritten summary that may drop a file path or a constraint, and nothing in the
transcript says the good path was skipped. A one-in-N network blip therefore
buys a permanent quality loss in that context window, not a retry.

This is the same class of defect that `pi-morph-plugin` shipped
(`formatPublicRepoResolutionFailure` swallowed the real `detail` and reported
every failure as "Repository not found"), and the same fix shape: do not let a
transport fault masquerade as a successful fallback.

## Decision

`src/retry.ts` wraps any `JevAsker` in a `withRetry` decorator, and
`src/index.ts` builds its client through it. Default 4 attempts, exponential
backoff from 300ms capped at 4s, and a `ctx.ui.notify` per retry so a slow
compaction is visible rather than mysterious.

Classification is deliberately narrow, and it is the load-bearing part:

- **Retried:** transport faults (`certificate`, `ECONNRESET`, `ETIMEDOUT`,
  `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`,
  `UND_ERR_*`, `fetch failed`, `socket hang up`, `premature close`,
  `malformed JSON`) and the retryable HTTP statuses (408, 425, 429, 500, 502,
  503, 504).
- **Not retried:** 400/401/403/404/422, and the engine's contract errors
  (`Jev response is missing answers`, `Invalid Jev answer for ...`,
  `TYPESAFE_API_KEY is not configured`).

Two details matter more than the list:

1. **The whole `cause` chain is classified, not just `error.message`.** Node's
   `fetch` reports `fetch failed` at the top and the real reason
   (`unable to verify the first certificate`) in `error.cause`. Matching only
   the top message would have missed the exact failure that motivated this
   file.
2. **An explicit HTTP status overrides the text heuristics.** A 401 whose body
   happens to contain "fetch failed" is still a credential problem and must not
   be retried.

Retrying a Jev ask is safe because asks are read-only probability questions;
there is no mutation to double-apply.

## Alternatives considered

**Retry every failure.** Simplest, and it would have fixed the observed bug.
Rejected because it turns a misconfiguration into a slow failure: a bad API key
would burn three backoff sleeps (up to ~5s) before reporting `401`, and the
retries would be logged as "transient", pointing the user at the network
instead of their key. The narrow classification costs one helper and buys an
honest error.

**Rely on pi's fallback and stop there.** pi already degrades gracefully, so a
failed compaction is not fatal. Rejected because the fallback is *silent and
lossy*: the extension's whole premise is that a summary loses facts that matter,
so treating "fell back to the summary" as an acceptable outcome for a transient
blip defeats the plugin.

**Retry at the engine level, inside `compact()`.** Would also cover the
`batchCalls` concurrency path. Rejected because it puts transport policy in the
vendored decision core, which is kept close to upstream
(`fast-jev-compaction`) so diffs stay readable. The decorator sits at the
boundary instead, and stays ours.

**A generic `fetch` retry shim.** Would cover any future Jev endpoint, but
cannot distinguish "this response is a valid answer" from "this response is a
schema violation", which is precisely the distinction the plugin needs. The
asker interface is the right seam.

## Consequences

A transient fault now costs one extra round trip (~300ms first backoff) instead
of silently replacing the compaction strategy.

The wrapper is observable: `onRetry` is injected, so tests assert on the exact
backoff schedule without waiting, and production wires it to a `ui.notify`. A
throwing notifier cannot break the retry — that is caught.

`JEV_COMPACT_MAX_ATTEMPTS` and `JEV_COMPACT_RETRY_BASE_MS` expose the policy.
The wrapper is a pure decorator over `JevAsker`, so it composes with any future
transport (the bench, for instance, could wrap its client the same way).

Residual risk: a fault that persists past the retry budget still falls back to
pi's summary. That is correct — retrying forever would stall the turn — but it
means the fallback path still exists and is still silent. If silent degradation
becomes a concern, the `details.provider` field on the compaction entry is the
place to record "fell back, and why".

## Verification

Tests live in `plugins/jev-compact/test/retry.test.ts`; they inject a fake
`sleep` and a scripted asker, so classification and backoff are asserted without
touching the network or waiting on a timer.

- `plugins/jev-compact/test/retry.test.ts::a transient failure is retried and the call succeeds`
- `plugins/jev-compact/test/retry.test.ts::a certificate fault nested in cause is retryable`
- `plugins/jev-compact/test/retry.test.ts::a non-retryable error fails immediately, without sleeping`
- `plugins/jev-compact/test/retry.test.ts::it composes with the engine: one blip does not fail a real compaction`

Proved: changed the first test's `flaky(1, ...)` to `flaky(9, ...)` so the
failure outlasted the retry budget → `a transient failure is retried and the
call succeeds` failed on the attempt count and the recorded backoff, then
reverted and re-ran green (22 pass, 0 fail).

Also verified against the live API: a simulated first-call TLS fault
(`fetch failed` with `unknown certificate verification error` in `cause`)
completed on transport call 2 and returned a real answer.
