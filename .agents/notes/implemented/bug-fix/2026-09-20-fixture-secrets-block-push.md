# Agent Note: Keep credential-shaped fixtures from blocking the push

Status: implemented

## Problem

This repository is a secret-redaction tool, so its tests must contain strings the
built-in rules recognise as credentials. Those were written as contiguous string
literals next to the test data, and the first attempt to publish the repository
was refused:

```
remote: —— Slack API Token ————————————————————————————————
remote:   - commit: 575b295…
remote:     path: plugins/redact/test/patterns.test.ts:28
remote: Push cannot contain secrets
! [remote rejected] HEAD -> master (push declined due to repository rule violations)
```

The values were dummies, but that is not something a scanner can know. Every one
of them (`ghp_…`, `AKIA…`, `xoxb-…`, `sk-ant-…`, a JWT, a PEM header) is shaped
exactly like the real thing, which is the point of the fixture.

Two costs, not one:

1. **The push is blocked.** GitHub push protection scans *commits*, so the fix had
   to remove the literals from history, not just from the working tree.
2. **Every later scan reports false positives.** The same eagerness that blocked
   the push makes any repository scan noisy, which teaches people to ignore it.

A related trap: this was diagnosed late because `pi-redact` itself was loaded in
the authoring session. It rewrote secret-shaped text inside tool output, so
`grep` and `read` showed `[REDACTED:github-pat]` where the file held a real-shaped
dummy. The scans disagreed with each other until the values were inspected as
hex, which no redaction rule matches.

## Decision

Fixtures live in `plugins/redact/test/fixtures.ts` and every value is assembled
from two concatenated halves. The runtime string is byte-identical; the source
contains no contiguous credential.

The split point is **not** the midpoint. It is chosen so that neither half matches
a rule on its own, because a half long enough to match is flagged exactly like the
whole — the first attempt at splitting at the midpoint left halves that still
matched, and the guard test caught it.

`test/no-secrets.test.ts` locks both directions:

- no rule matches a contiguous literal anywhere in repository source, and
- every assembled value is still recognised by its rule, so the fixture-based
  tests cannot silently start asserting on a non-secret.

The oracle is the plugin's own `SECRET_PATTERNS`, so the guard is exactly as
strict as the shipped redactor and cannot drift from it. Values whose capture is
not token-shaped — several rules deliberately match config markers such as
`[REDACTED:gcp-service-account]` — are ignored, because a rule's regex source
appearing in `patterns.ts` is not a committed credential.

Two gates run it without an agent having to remember:

- `bun run secrets` runs the guard test directly.
- `pre-commit` runs it before every commit, so a reintroduced literal cannot
  enter history. It also prints what to do: move the value to `fixtures.ts` and
  split it so neither half matches.

`AGENTS.md` carries the rule as prose, because a gate only helps if the agent
that hits it knows the intended fix rather than adding the next allowlist entry.

## Alternatives considered

**Add the values to a scanner allowlist (`.gitleaksignore`, GitHub's unblock
URL).** Works, and is the documented escape hatch, but it pushes the work onto
every consumer: each clone, each CI job and each new scanner needs the same
exemption, and the noise that trains people to ignore findings stays.

**Move the fixtures into a non-source file (JSON, `.txt`) or generate them at
test time.** A scanner reads those files too, so this only relocates the problem.
Generating from a seed adds machinery to every test that needs a value.

**Use obviously fake values that no rule matches.** Then the tests would no
longer exercise the rules at all, which is the opposite of their purpose.

## Consequences

Tests are slightly less direct to read — a fixture is a named constant rather
than an inline string — but they are more readable in aggregate, since a value is
now named and documented with the rule that recognises it.

The guard hard-codes repository layout (the workspace root is derived by walking
up from the test file). That is acceptable for a workspace-level test; if the
layout changes, the test fails loudly rather than silently passing.

The guard matches token-shaped captures only. A future rule whose secret
legitimately contains spaces or quotes would not be enforced, which is the
intended trade: it is what keeps the rule set's own regex sources from being
reported as secrets.

## Verification

- `plugins/redact/test/no-secrets.test.ts`

The first test walks every `.ts`/`.js`/`.json`/`.md` file outside `node_modules`
and asserts no rule matches a token-shaped contiguous literal. The second asserts
each fixture value is still recognised, the third that no half of a split matches
on its own, and the fourth that a planted known-shaped value is caught, so the
detector cannot pass vacuously.

Proved: prepended `const PLANTED = "<a full Slack token>";` to
`plugins/redact/test/patterns.test.ts` → "every source file is free of
contiguous secret-shaped strings" failed as expected, and `sh
.githooks/pre-commit` exited 1 with its guidance message; then reverted.
Separately, an earlier midpoint split of the fixtures was caught by "neither half
of a split fixture matches a rule on its own", which is why the split points are
searched rather than assumed.
