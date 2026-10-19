# Agent Note: Close the generic-credential gap in pi-redact

Status: implemented

## Problem

The four catch-all rules (`api-key`, `webhook-secret`, `secret-value`,
`password`) failed in two independent ways, and both shipped with a green
suite:

1. **Name coverage.** The rules only recognised `api_key`/`api-token` and
   `*_secret`. `GITHUB_TOKEN`, `ACCESS_TOKEN`, `SLACK_TOKEN`, `NPM_TOKEN`,
   `apiKey`, `APIKEY`, `PRIVATE_KEY` and
   `DATABASE_URL=postgres://user:pass@host/db` never reached a rule at all.
   Vendor-prefixed values (`ghp_…`, `xoxb-…`) were still caught by their own
   rules; opaque values in a `.env` dump were not.
2. **Misplaced lookahead.** The placeholder check
   `(?!.*(?:api|key|secret|…))` sat inside the capture group, so it scanned
   the rest of the line. A trailing comment cancelled the match:
   `API_KEY=<value> # api key for prod` passed through unchanged. The same
   `.*` at every start position made the rules quadratic: 40,000 spaces took
   1,238 ms and 200,000 spaces took minutes. An earlier commit fixed this
   shape in the PEM rule only.

## Decision

Replace the four rules with two bounded ones:

- `env-credential` matches a credential-shaped name (`*_TOKEN`, `apiKey`,
  `*_SECRET`, `*_PASSWORD`, `PRIVATE_KEY`, …) followed by `:`/`=` and a
  bounded value. The placeholder lookahead is applied to the candidate value
  (≤128 chars), not to the line. Metric names (`max_tokens`, `token_count`)
  and TypeScript type words (`string`, `number`) are excluded.
- `url-credential` captures the password in `scheme://user:password@host`.

All quantifiers are bounded, so the cost is linear in the payload.

## Alternatives considered

**Keep four rules and patch each lookahead.** Four near-identical regexes
with the same shape is how the PEM fix missed the other four in the first
place. One generic rule has one place to get wrong.

**Reject values with entropy scoring in code.** More accurate in principle,
but the engine is regex-driven and a second matching model would have to be
kept in sync with the pattern list. The bounded regex fixes both the leak and
the stall without a second code path.

## Consequences

`GITHUB_TOKEN=` and friends are redacted, including with trailing comments
and quoted/JSON values. The rule id in the marker changes from `api-key` /
`secret-value` / `password` to `env-credential` (and `url-credential` for a
URL). `sk-secret` stays ahead of the generic rule so vendor-prefixed values
keep their specific label. False positives are possible for code such as
`token = "something"`, which is the safe direction; call-like values
(`apiKey: resolveKey()`) and type annotations are excluded.

## Verification

- `plugins/redact/test/generic-credentials.test.ts` — 12 names, trailing
  comments, quoted/JSON, URL credentials, placeholders, and a 40k-space
  timing bound.
- `plugins/redact/test/no-secrets.test.ts` — the new rule must not match the
  repository's own source.

Proved: with `plugins/redact/src/patterns.ts` restored, the new test fails on
`GITHUB_TOKEN is redacted` (and the other names). Before the fix, a probe
measured `GITHUB_TOKEN`, `ACCESS_TOKEN`, `SLACK_TOKEN`, `NPM_TOKEN`,
`apiKey`, `APIKEY`, `PRIVATE_KEY` and the database URL all unchanged, and
40,000 spaces at 1,238 ms. After the fix the same input is redacted and
40,000 spaces take ~1 ms.
