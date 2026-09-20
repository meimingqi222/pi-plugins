# Agent Note: Redaction deep-walk needs a recursion stack

Status: implemented

## Problem

`redactDeepInner` in `src/engine.ts` recursed through objects and arrays with
no record of the nodes it was already visiting. A value that refers to itself,
or any two values that refer to each other, recursed until the stack was
exhausted:

```
RangeError: Maximum call stack size exceeded
```

The engine is the only gate standing between a session and the provider, and
`src/index.ts` routes every provider call through it. When the walk throws,
the `before_provider_request` handler returns `undefined`, so pi sends the
**original, unredacted payload**. A crash is therefore not a degraded
redaction: it is a silent disclosure of exactly the credentials the extension
exists to strip. Cycle-bearing payloads are not exotic — provider payloads can
carry shared references, and a self-referential object is one `obj.self = obj`
away.

## Decision

`redactDeepInner` threads a `WeakSet<object>` recursion stack. A node is added
only while its own children are being visited, and removed on the way out.
A node already on the stack is returned unchanged (the cycle is truncated
rather than followed).

Marking "while visiting" rather than "ever seen" is the load-bearing detail:
the same object appearing in two sibling positions is still walked twice, so
the second reference cannot leak a secret the first one redacted. This mirrors
`redactJson` in `src/pi-bridge.ts`, which already used the same technique.

## Alternatives considered

**A `seen` set that is never cleared.** Cheaper, and it also stops the crash,
but it treats a node as done the first time it is entered. A payload that
references one object from two branches would have its second branch returned
by reference, skipping the walk and leaking the raw string. The failure is
silent and data-shaped, so it is worse than the crash it replaces.

**Depth limit.** Bounds the stack without a set, but a deeply nested *acyclic*
payload — plausible for large tool output — would be silently truncated, and
the truncation point would depend on the depth counter rather than on actual
cycles. It trades a loud crash for a quiet hole.

**Try/catch around the walk.** Turns the crash into a caught error, but the
handler's fallback is to send the original payload, so catching does not
redact the cycle — it only hides that redaction did not happen.

## Consequences

The walk allocates one `WeakSet` per top-level call and does a `has`/`add`/
`delete` per container. Keys are weak, so no payload is retained past the call.
The `deep()` entry point on `Redactor` allocates the set once per call rather
than per node, so the cost is a constant per redaction, not per field.

The guard is scoped to the recursion stack, so a shared node is visited twice —
the correct behavior for redaction, and the reason the sibling test exists.

## Verification

Tests live in `plugins/redact/test/engine.regression.test.ts`; the cycle is built from object
references so the walk is the only thing under test.

- `plugins/redact/test/engine.regression.test.ts::cyclic input does not overflow the stack`
- `plugins/redact/test/engine.regression.test.ts::mutual cycles are broken and sibling secrets still redacted`
- `plugins/redact/test/engine.regression.test.ts::a node shared between siblings is redacted in both`

Proved: removed the `inProgress` bookkeeping so the walk recursed without a
stack → `cyclic input does not overflow the stack` and `mutual cycles are
broken and sibling secrets still redacted` both failed with
`RangeError: Maximum call stack size exceeded`, then reverted and re-ran green.
