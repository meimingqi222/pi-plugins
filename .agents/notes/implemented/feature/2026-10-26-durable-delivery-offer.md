# Agent Note: Durable offer/ack for background results

Status: implemented

## Problem

A workflow run settles after the turn that launched it is gone. The plugin sent
the result as a custom message when the origin was still current and discarded
it otherwise, and nothing recorded the result anywhere the session could read
afterwards:

- a process exit between settlement and the settled-boundary send lost a result
  the run had already paid for;
- a switch away (or a `/reload`) cleared the in-memory queue;
- the result could not be recovered from disk either: the journal holds each
  agent's answer and `progress.json` holds the terminal status, but the
  script's return value exists only in the registry record.

The OpenCode job model in the reference agents solves this with a durable
background record keyed by notification id. pi sessions already have a
branch-aware append log, so the same guarantee does not need a second store.

## Decision

Add `DeliveryLedger` to `pi-run-core` and use it for workflow results.

- On settlement, **offer** the delivery to the active branch:
  `{ id, runId, sessionId, customType, content, display, wake, details, createdAt }`.
  The id is `wf:<runId>`; a run settles once.
- Send the message, then **ack** it with a branch entry. Both writes are
  best-effort: a full disk costs the replay, never the live result.
- On `session_start` and `session_tree`, read the branch and replay offers that
  belong to the current session and have neither an ack nor a delivered message.
- A `custom_message` whose `details.deliveryId` matches an offer counts as
  delivered. That is what makes a crash between send and ack harmless instead
  of a duplicate.
- The offer stores only `{ runId, name, status }` for the renderer. The full run
  record stays in the journal; replay exists to deliver the answer, not to
  resurrect a registry.
- `wake` is recorded with the offer so a replay uses the same policy as the live
  path: a completed or failed result wakes a turn, an aborted transcript entry
  does not.

`pi-subagent` uses the same ledger with `sa:<laneId>:<revision>` ids:

- an answer is offered when the lane produces a result revision, before the
  settled-boundary send;
- the live send carries `details.deliveryId`, so the transcript suppresses a
  replay in the crash window;
- `show`/`wait`/`log` call `consume()`, which acknowledges the revision because
  the model already read it;
- a replay picks only the newest unacknowledged revision per lane and
  acknowledges the older offers, so a lane that answered several reply turns
  does not dump a backlog;
- an origin without `sessionId` (tests, session-less hosts) stays in-memory:
  durability is opt-in at the launch site, not a hidden assumption.

`pi-bg-bash` uses `bg:<jobId>` ids and offers only a completion that is allowed
to wake the model:

- `notify: "quiet"` and an `auto` success are never offered, so durability
  cannot turn a silent completion into a wake;
- the live notice batches several jobs, so its details carry `deliveryIds`
  rather than one id — an array is what lets one transcript message prove every
  offer it covers;
- `bg_tasks result`/`wait` consume the notice and acknowledge the offer;
- a replay batches all pending notices for the session into one message again.

A run that settles after its session was left does not get an offer at all: that
is still a discarded result, and the boundary is unchanged.

## Alternatives considered

**Keep a JSON file under `.pi/workflows`.** It has no branch semantics: a
result offered on one branch would replay into another, and deleting a branch
would not delete its offers. The session log is already the branch-aware store.

**Use `sendMessage` as the durable record.** The host acceptance is the event we
cannot observe reliably; writing the offer first is what makes recovery
possible when the process dies before acceptance.

**Persist the entire `RunRecord` in the offer.** The record can carry a progress
snapshot with every agent, so every result would double its size in the session
file. The renderer needs three fields; the rest is already on disk.

**Ack before send.** A failed send would leave an offer that can never be
retried, which is the original loss with extra bookkeeping.

## Consequences

A workflow result survives reload and branch navigation and is delivered exactly
once in the normal cases:

- send succeeds, ack succeeds: no replay;
- send succeeds, process dies before ack: transcript check suppresses replay;
- send never happens: replay on the next start/tree boundary;
- session left before settlement: no offer, still discarded.

Session entries grow by one offer and one ack per settled run. They are small
and bounded by the number of runs, not by transcript size.

## Verification

- `plugins/run-core/test/delivery-ledger.test.ts` — offer pending until ack,
  session scoping, transcript dedupe, malformed entries, failed append.
- `plugins/workflow/test/delivery-replay.test.ts` — one replay then ack,
  duplicate suppression, session mismatch, passive aborted replay.
- `plugins/subagent/test/delivery-replay.test.ts` — one replay then ack, newest
  revision only, consumed result not replayed, session mismatch.
- `plugins/bg-bash/test/delivery-replay.test.ts` — one replay then ack, batched
  transcript dedupe, session mismatch, malformed offer, and a **real failing
  job** offered before a simulated reload.
- `plugins/run-core/test/delivery-ledger.test.ts` — one batched message proves
  several offers delivered via `deliveryIds`.

Proved: removing the transcript check (`delivered` set) made
`a result already present in the transcript is not replayed without an ack`
fail with `Expected length: 0, Received length: 1` (`0 pass, 3 filtered, 1
fail`). Removing the replay's ack write made
`an unacknowledged result is delivered once when its branch reopens` fail at the
ack assertion (`Expected: true, Received: false`; `0 pass, 3 filtered, 1 fail`).
Removing the lead's offer write made
`an offered answer is replayed once after a reload` fail with zero sends.
Removing the newest-revision selection made
`only the newest revision per lane is replayed` send two.
Removing the bg-bash offer write made
`a real failing job offers its completion before a reload` time out waiting for
the offer (`0 pass, 4 filtered, 1 fail`). Removing the batched-id check from the
ledger made `a notice already in the transcript is not replayed without an ack`
send one where zero is expected. All were restored.
