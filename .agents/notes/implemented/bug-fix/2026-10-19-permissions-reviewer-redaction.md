# Agent Note: Redact the pi-permissions reviewer payload

Status: implemented

## Problem

In `auto` mode a grey-tier call is sent to a reviewer. The `jev` backend
posts the whole call and the user's last message to
`https://api.typesafe.ai/v1/systemone` with its own `fetch`, so the request
never passes through pi-redact's `before_provider_request` hook. A user who
pasted a credential into a prompt and then made one grey call sent it to a
third party in the clear. `pi-permissions` had no reference to pi-redact at
all, while `pi-jev-compact` already solved the identical problem with a
versioned event-bus bridge.

## Decision

Install the same redaction bridge in `pi-permissions` and redact the reviewer
payload at the transport edge, after the backend is selected and before either
backend is called. The Jev backend is fail-closed: if pi-redact is absent,
paused, or throws, the reviewer returns "no verdict" and the call falls back
to asking the user. The registry backend redacts when the service is present
and otherwise keeps its previous behaviour, because that path already goes
through pi's provider pipeline, which pi-redact gates when installed.

## Alternatives considered

**Import `pi-redact` directly.** Reintroduces a package dependency between
plugins that are published independently, and breaks installing either alone.

**Require pi-redact at installation.** Disables `auto` mode for users who do
not run the redactor, including those who configured a registry reviewer that
does not need the bridge.

**Redact only `toolInput`.** The user request carries the same class of
credential ("deploy it, the token is …"), so both fields are redacted.

## Consequences

A missing or failing redactor degrades to a prompt instead of an unredacted
upload. `PI_PERMISSIONS_REVIEWER_REQUIRE_REDACT=0` restores the old
behaviour for a deployment that accepts the risk. Redaction preserves object
keys, so the Jev answer still maps back to its question.

## Verification

- `plugins/permissions/test/reviewer.test.ts` — "the jev payload is redacted
  before it leaves the process" asserts the wire body contains no sentinel,
  and "without a redaction service the jev backend fails closed" asserts no
  request is made.

Proved: with `plugins/permissions/src/reviewer.ts` and `plugins/permissions/src/index.ts` restored, the
redaction test fails (`expect(received).not.toContain(expected)`) and the
fail-closed test receives a verdict instead of `undefined`, because the old
path sends the raw payload.
