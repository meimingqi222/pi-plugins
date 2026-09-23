# Agent Note: The real executor never parsed a structured reply

Status: implemented

## Problem

A real run (`wf_bd46e7adf9764ef3`) aborted after 595 s with all nine agents
failed and the symptom
`The agent did not satisfy its schema after 1 attempt: $ must be object`
— a type error, for a reply that was a 19 KB JSON object.

The reply was malformed JSON, which is a model failure the retry loop exists to
repair. But the reported error and the reason the repair never ran are both
plugin defects, and the second one is systemic rather than a bad script:

`pi-executor.ts` set `value: state.finalText` on its completed path — the raw
reply *text*. In `runAgent`, `result.value !== undefined ? result.value :
tryParse(result.text)` therefore always took the text, so:

1. `parseStructuredReply` — including its Markdown-fence unwrapping — was
   **dead code** in production. A reply that is valid JSON inside a
   ` ```json ` fence, the most common model habit, is handed to the validator as
   a string and rejected with `$ must be object`.
2. A genuinely malformed reply produced the same misleading type error instead of
   "The reply was not JSON", so the repair prompt quoted a type complaint rather
   than the actual parse failure.

No test caught it because every test of the schema retry uses a fake executor
that returns an already-parsed `value`. The production path between the two was
never exercised end to end. The evidence for how deep this goes is on disk: of
the 17 run directories in this workspace, exactly the ones written *after* the
failure-journaling fix have a `journal.jsonl` at all — the earlier 16 have none,
which under the fix means zero successful agent calls, i.e. any run whose script
asked for a schema had been failing this way since the plugin shipped.

A second defect sat behind the first: `runAgent` merged usage across attempts but
threw a bare `Error`, so the orchestrator recorded
`usage: emptyWorkflowUsage()` for a failed call. The run reported
`9 agents · 0 tokens` after nine agents each burning ~111 K tokens. The token
axis of the budget is fail-closed, so a budget checked against a cost that is
reported as zero is not fail-closed at all.

## Decision

**Parse at the boundary, and let the orchestrator keep it.** Two changes:

- The executor returns `value` only when the reply parses, and leaves it
  undefined otherwise. That puts the reply back on the `text` path where
  `parseStructuredReply` is reached: fences unwrapped, malformed reported as
  "not JSON". The value is not defaulted to the text, because handing a string
  to a validator that declared an object is a misreport, not a fallback.
- `runAgent` throws `RunAgentError` carrying the usage its attempts spent, and
  the orchestrator merges it into the run's usage, records it against the budget,
  and journals it on the failed entry. A failed attempt is charged, because a
  schema repair is a real model call — usually the most expensive one.

The regression tests drive the *real* executor through `runAgent`: the fixture
now takes its reply payload from the prompt (`JSONREPLY:` / `FENCED:` / `BROKEN:`
with one quote misplaced, which is the failure the real model produced). This is
the test surface that was missing, and it is the only one that can catch a
wiring bug between the two modules.

## Alternatives considered

**Keep `value` as the text and unwrap in the validator.** It would make every
caller of `validateWorkflowSchema` responsible for a transport detail, and the
validator's job is the schema, not the reply's formatting.

**Parse inside `runAgent`'s `tryParse` path only, and make the executor omit
`value` by changing the interface.** Same code, but it depends on every future
executor remembering not to set `value`. Parsing in the executor and omitting on
failure keeps `value` meaning "a parsed value" rather than "something".

**Record the real usage but leave the budget untouched.** Inconsistent: the
budget admission asks how much has been spent, and an answer that omits failed
attempts lets a run of failing agents exceed its token budget by multiples.

**Make a schema failure non-fatal for the run.** The script can already catch it;
`agent()` throwing is the contract a script is written against.

## Consequences

A structured agent call now works at all, which is why every schema-using run
before this was failing. Fenced JSON is accepted, malformed JSON gets a
diagnosis that names the actual problem, and a fully failed run reports its real
cost — so `/workflows` and the budget see money that was spent.

A reply the model emitted as plain text where the script declared a schema is
now consistently a failure instead of being validated as a string, and
`WorkflowAgentRunResult.value` no longer carries text, so a caller that reads
`value` gets a parsed value or nothing.

## Verification

- `plugins/workflow/test/end-to-end.test.ts` — a new `structured replies` block
  drives real spawned agents: a bare JSON reply validates, a fenced JSON reply
  validates, a malformed reply fails with "not JSON" rather than a type error,
  and a failed call reports non-zero `spentTokens`
- `plugins/workflow/test/fixtures/fake-pi.mjs` — driven by prompt markers, so the reply body is a
  test input rather than an accident of the fixture
`206 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: two red runs, each reverting one half.

- **`readStructuredReply` bypassed** (the executor passed the raw text as the
  value). It failed
  `structured replies > a fenced JSON reply is unwrapped rather than rejected as
  a string` with `Expected: "completed", Received: "aborted"` — the exact
  reported symptom, reproduced from the fixture.
- **`RunAgentError` carrying `emptyUsage()`.** It failed
  `structured replies > a failed call still reports the tokens it spent` with
  `Expected: > 0, Received: 0`.
