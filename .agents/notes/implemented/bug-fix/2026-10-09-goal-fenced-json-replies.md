# Agent Note: Parse a fenced verdict and planner reply

Status: implemented

## Problem

`parseVerdict` and `parsePlannerPlan` called `JSON.parse` on the raw model reply,
while the shared isolated-call judge unwrapped a ```json fence first. Models
wrap JSON in a fence as a formatting habit, so the two goal paths failed on
replies the shared primitive accepts:

- a fenced verdict threw a raw `SyntaxError`, and the goal paused with
  `Verification failed`, discarding a claim that was in fact well-formed — one
  wasted verification round per fenced reply;
- a fenced planner reply was swallowed as "Goal plan unavailable", leaving the
  goal with no acceptance criteria at all, which is the failure the criteria
  machinery exists to prevent.

Neither outcome is silent-corruption, but both are avoidable and both were
untested. The fence convention existed twice: once in `parseJsonReply` and once
implicitly in what goal refused to accept.

## Decision

Move the fence convention into one shared export, `stripJsonFence`, in
`pi-run-core` next to `parseJsonReply`, and have both goal parsers strip the
fence before their own strict shape validation. Goal keeps its own validation
and its own error text ("Invalid plan", "Invalid verification verdict", the
per-field caps): the shared helper owns *unwrapping*, goal owns *what a valid
verdict or plan is*.

Rejected: routing goal through `parseJsonReply` itself. Its validator shape
forces the shared error message ("The reply did not match the required shape")
to replace goal's field-level diagnostics, which are what tell the planner and
the user which field was wrong. Rejected: copying the fence regex into goal —
that is the drift this helper exists to prevent.

## Alternatives considered

- Leave it and document "unwrap your fence": a formatting habit is not a
  contract the model can be expected to honour.
- Loosen goal's validation instead (accept `passed` as a string, etc.): widens
  what counts as a verdict, which is the opposite of the intent.

## Consequences

A fenced reply and an unfenced reply now parse identically in all three places
that read a model's JSON (the isolated judge, the verifier, the planner).
`stripJsonFence` becomes public API of `pi-run-core`; a later consumer of a
model reply should use it rather than writing a fourth regex. Malformed JSON
still throws, and non-object replies are still rejected, so the strictness that
guards "a planner cannot invent criteria" is unchanged.

## Verification

- Test file: `plugins/goal/test/lifecycle.test.ts`
- Test file: `plugins/goal/test/plan.test.ts`
- Test file: `plugins/run-core/test/run-core.test.ts`
- `plugins/goal/test/lifecycle.test.ts::a fenced verdict parses instead of failing the goal`
- `plugins/goal/test/plan.test.ts::accepts a fenced planner reply`
- `plugins/goal/test/plan.test.ts::still rejects a reply that is not a plan object`
  is the negative control: a fenced array, string or criteria-less object is
  still refused.
- `plugins/run-core/test/run-core.test.ts::stripJsonFence unwraps one fence and nothing else`

Proved: before the fix, `bun test plugins/goal/test/lifecycle.test.ts
plugins/goal/test/plan.test.ts` reported 113 pass / **2 fail** — `(fail) goal
safety boundaries > a fenced verdict parses instead of failing the goal` and
`(fail) planner payload > accepts a fenced planner reply [1.21ms]`, both with
`JSON Parse error: Unrecognized token '\`'`. With the fix the same command is
115 pass / 0 fail, and the negative control passes in both runs.
