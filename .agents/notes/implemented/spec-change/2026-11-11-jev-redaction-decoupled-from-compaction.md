# Agent Note: Keep Jev compaction independent of pi-redact

Status: implemented

## Problem

`JEV_COMPACT_REQUIRE_REDACT` defaulted to `true`, so an absent, filtered-out, or
paused `pi-redact` made every Jev upload throw, which fell back to pi's built-in
summarizer. A user who deliberately did not run `pi-redact` — or who disabled
just its extension while keeping the package installed — lost the feature they
installed `pi-jev-compact` for, with the only signal a warning at compaction
time. The privacy decision was correct but the coupling was not: redaction is a
property of the *installation*, and compaction must not be gated on another
plugin's presence.

## Decision

`requireRedact` defaults to `false`. Redaction still runs on every upload
whenever a compatible v2 service announces itself, and it still fails closed when
the redactor throws. Strictness is opt-in: `JEV_COMPACT_REQUIRE_REDACT=true`
restores the previous behaviour of refusing the upload instead of sending it
unredacted.

The startup notice reports only a state worth acting on. A missing `pi-redact`
is silent: compaction works, the upload is simply not redacted, and that is the
default installation rather than an anomaly.

## Alternatives considered

**Leave the default at `true` and document `JEV_COMPACT_REQUIRE_REDACT=false`.**
This was the shipped behaviour. It loses because it makes the default
configuration of one plugin depend on the presence of another, and because the
failure mode (silently using pi's summary) looks like a bug in compaction rather
than an intended privacy gate.

**Drop the flag entirely and always upload.** Loses the deliberate choice: a user
who knows this conversation may contain a credential pasted into the prompt must
be able to forbid the upload rather than trust pattern detection. The flag is
kept, only inverted.

**Require the redactor only when detection is likely.** No reliable signal exists
before the redactor has run, and guessing would send the payload that the strict
mode exists to withhold.

## Verification

`plugins/jev-compact/test/redact-integration.test.ts::an absent pi-redact does not disable compaction by default`
and `plugins/jev-compact/test/redact-integration.test.ts::strict mode is opt-in, not the default`

Proved: with the default reverted to `true`, both tests failed —
`expect(loaded.sent.length).toBeGreaterThan(0)` received `0`, and the startup
notice test saw a refusal notice where it expects silence. Reverting the default
to `false` restored them. Red output:
`regression-evidence/jev-redaction-decoupled-red.txt`.

## Consequences

Uninstalling or filtering `pi-redact` no longer breaks `pi-jev-compact`; the
upload goes out unredacted, silently. The trade is that the guarantee is no
longer on by mistake — a user who wants it must assert it. The bus handshake and
per-request fail-closed behaviour on a throwing redactor are unchanged, as is
the "paused means the user's explicit choice" pass-through.

Silence for the absent case is deliberate, not an omission: it is the default
installation, and a warning on every session start about a state the user chose
trains them to ignore the notices that do matter (strict mode refusing the
upload, a paused or unverifiable service).
