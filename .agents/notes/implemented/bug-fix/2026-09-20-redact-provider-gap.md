# Agent Note: Redact the outbound Jev payload, not just the provider payload

Status: implemented

## Problem

`pi-redact` gates the payload pi sends to a model through `before_provider_request`
(plus `context` and `tool_result` for depth). `pi-jev-compact` posts a full
conversation to TypeSafe's System One endpoint with its own `fetch`, so that
request never passes through any of those hooks.

With both plugins loaded, the same secret was therefore redacted from the model
request and **uploaded in the clear** to TypeSafe in the same turn. The leak was
silent: the compaction still succeeded, and nothing in the transcript showed that
a second copy had left the machine.

The exposure surface is narrower than it first looked, and measuring it changed
the fix. The Jev state replaces a tool result's *contents* with
`ok, N chars (omitted)`, so a secret buried in tool output never reaches TypeSafe
at all. The surfaces that do carry text are:

- user messages (the common case — a credential pasted into the prompt);
- assistant text;
- tool **arguments** (`bash(command="export GH_TOKEN=...")`).

A fixture that hides the secret in tool output proves nothing; the integration
test plants it in all three real surfaces.

## Decision

`pi-redact` publishes a versioned redaction service on pi's documented
inter-extension bus (`pi.events`, channel `pi-redact:service`). `pi-jev-compact`
subscribes, validates `version` at runtime, and wraps its asker so `redactJson`
runs on the state and questions immediately before upload. The wrapper sits
**outside** the retry loop, so every attempt reuses the one redacted payload
rather than re-reading the raw input on a retry.

Redaction **fails closed**: if the redactor throws, the ask is aborted instead of
falling through to the raw payload. Aborting makes the extension fall back to
pi's own summary, which is a safe degradation; sending the secret is the exact
outcome the bridge exists to prevent.

That guarantee requires the *announced* service to propagate engine errors, so it
is deliberately **not** wrapped in pi-redact's own `safe()` helper. `safe()` fails
open (returns the raw value on error), which is correct for pi's own provider
payloads — blocking the request would break the session — but wrong for a
consumer whose contract is fail-closed. The paused case still returns the input
unchanged, because that is the user's explicit choice rather than a failure.

Discovery must complete in either load order, and pi has no "wait for extension
X" primitive. A consumer that hears no announcement emits on
`pi-redact:service-request`, and `pi-redact` re-announces. Whichever plugin loads
second, the handshake closes.

Neither plugin declares the other as a dependency. `pi-jev-compact` works
standalone by default (the asker is returned untouched when no service is present).
The optional `JEV_COMPACT_REQUIRE_REDACT=true` mode refuses a Jev request when
the service is absent, paused, or has no verifiable active state; pi then uses
its own summary. The service protocol is v2 with a live `isEnabled()` method.
The older v1 protocol remains usable in default mode, but cannot satisfy strict
mode: presence alone cannot prove that `/redact off` has not returned raw text.

## Alternatives considered

**Import `pi-redact/engine` from `pi-jev-compact`.** The engine is already
exported as a subpath, so this needs no new code. It was rejected because it
makes the two packages depend on each other: `pi-redact` is deliberately not
resolvable from `pi-jev-compact` today (verified — `import('pi-redact/service')`
fails), and the standalone-install requirement means that must stay true. It
would also duplicate redaction into a caller that can forget to apply it.

**Duplicate the 112-rule engine in `pi-jev-compact`.** No cross-package coupling,
but two rule sets that drift, and every future pattern has to be added twice.

**Patch `globalThis.fetch` in `pi-redact`.** Covers any extension's outbound
traffic without cooperation. Rejected as too broad — it intercepts unrelated
network calls and image/non-secret traffic — and brittle across runtimes.

**Document the gap in both READMEs and leave the ordering to the user.** Load
order is not controllable: `ExtensionAPI` has no `priority` or `order` field,
handlers run in extension load order, and there is no declared dependency
mechanism. Even with `pi-redact` first, `session_before_compact` builds its
messages from the session branch rather than from `pi-redact`'s output, so
ordering could never have closed the gap. The bus is the only channel that does.

## Consequences

The two plugins stay independently installable and publishable, at the cost of a
runtime contract that the compiler cannot check. The channel names and version
live in two files on purpose; a test asserts the copies agree. The consumer
accepts v1 for backward-compatible default behavior and v2 for strict mode;
unknown versions are ignored rather than guessed at.

`pi-jev-compact` now depends on pi's `pi.events`, which older pi versions may not
expose. By default the bridge degrades to unredacted rather than throwing,
matching the pre-bridge behaviour; strict mode refuses upload instead. The
startup notice describes the observable state, not a guarantee that every
sensitive string matches a redaction rule.

A user-visible notice distinguishes the protected and unprotected cases, so the
protection cannot be assumed present merely because both plugins are installed.

## Verification

- `plugins/jev-compact/test/redact-integration.test.ts`
- `plugins/jev-compact/test/redact-bridge.test.ts`
- `plugins/redact/test/index.test.ts`

The load-order integration case ("a secret in user text, assistant text and tool
args never reaches TypeSafe") runs twice, once per load order. Fail-closed is
pinned on both sides: the consumer by "a broken redactor fails closed instead of
uploading the raw payload", and the producer by "the announced service
propagates engine errors instead of failing open". Late discovery is pinned by
"re-announces when a consumer loads late and asks". The user-visible protection
notice is pinned by "the startup notice reports whether the upload is protected".

Proved (2026-09-26): before adding the strict service check, "strict mode
refuses upload without pi-redact and accepts it after a late announcement"
resolved instead of rejecting, and the integration test "strict mode without
pi-redact falls back to pi without sending a request" observed one raw upload.
After the v2 state check, the missing/late, paused, both load orders, and
redactor-error tests pass. The original default pass-through test still passes.

Proved: stubbed the bridge's `service` lookup to `undefined` (restoring the
pre-bridge pass-through) → the two integration cases, the redaction case, and
both fail-closed cases failed as expected; reintroduced the `safe()` wrapper
around the service → "propagates engine errors instead of failing open" failed
as expected; separately removed the startup notice → its test failed as
expected. Reverted all three and the full suite passed (195 tests across both
plugins).
