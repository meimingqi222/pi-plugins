# Agent Note: Session approval is an applied and scoped transaction

Status: implemented

## Problem

Allow for this session generated a prefix rule for dynamic commands even though
the matcher intentionally rejects such allow rules. Repeats kept asking. The
queue serialized only dialogs, so already queued calls never saw a prior grant.
Answers accepted after session reset, cancellation or a switch to read-only
could still run tools and pollute the new session. Children inherited only mode,
losing session grants and the session sandbox switch.

## Decision

Dynamic calls use a SHA-256 key of canonical tool input, canonical cwd and shell
settings for an in-memory exact-call grant. Keep static rule behavior and do not
relax dynamic prefix matching. Hide project grants when no usable rule exists;
explicit ask rules offer no ineffective session/project grant.

Serialize rechecking, prompting and applying grants as one transaction. Recheck
before prompting and after the answer. Link UI/reviewer signals to a permission
lifecycle controller; mode/config/session changes invalidate old requests.
Cancel/reset/shutdown cannot execute or persist an old approval. Reject answers
for unavailable options.

Publish a versioned, cwd-scoped session snapshot for new children: allow rules,
exact-call digests and sandbox override. Validate shape and size before use;
wrong-directory, invalid or over-8-KiB snapshots confer no grants. Child policy
still enforces forbidden, read-only and explicit deny/ask before session grants.

## Alternatives considered

- Permit dynamic commands through prefix allow rules: grants unrelated dynamic
  invocations and removes a deliberate matcher boundary.
- Remove the session option: avoids a false promise but loses useful repeat
  approvals.
- Deduplicate by display summary: truncated text can collide for distinct calls.
- Recheck while still serializing only UI: grant application can race with the
  next queued request. The whole transaction must be serialized.
- Re-evaluate only in the parent: headless children still lose authorized grants.

## Consequences

Session approvals cover exact dynamic syntax, not frozen shell variable values.
Changed input, cwd or shell settings requires new approval. Static prefix grants
retain their existing behavior. Waiting repeats reuse applied grants. Children
receive a spawn-time snapshot; already running children are not updated live.
Oversized snapshots deliberately lose child grants rather than exceed process
environment limits or widen permission. Raw dynamic payloads are not copied to
the inherited environment. YOLO does not enter the approval path for ordinary
safe/grey/dangerous calls.

## Verification

Test file: `plugins/permissions/test/plugin.test.ts`.

- `plugins/permissions/test/plugin.test.ts::dynamic session approval covers exact input only and offers no persistent rule`
- `plugins/permissions/test/plugin.test.ts::queued session approvals recheck before prompting`
- `plugins/permissions/test/plugin.test.ts::pending approvals cannot outlive`
- `plugins/permissions/test/plugin.test.ts::explicit ask rules do not offer ineffective session grants`
- `plugins/permissions/test/plugin.test.ts::children inherit scoped session grants and sandbox override but keep deny rules`
- `plugins/permissions/test/session-context.test.ts` validates scope/schema/size
  and stable hashes that distinguish input, cwd and shell settings.

Proved: the pre-fix wiring run reported failures for dynamic session options,
both static and dynamic queued repeats (three dialogs), all three original
pending lifecycle cases (reset, read-only, abort), ineffective explicit ask
grants and child inheritance. The run had 27 pass / 10 fail including the two
independent mode/read-only bugs. After implementing transactions, exact grants
and scoped inheritance, the complete permissions suite passes these cases and
additional shutdown/schema/hash cases.

Final verification: `bun run typecheck`, `bun run test` (1461 pass / 0 fail across 13 packages), and `bun run notes` passed.
