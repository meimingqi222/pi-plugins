# Agent Note: Retire a finished goal from the model context and the status bar

Status: implemented

## Problem

`pi.on("context")` injected `goalPrompt(goal)` whenever `goal` was set, with no
status check. A goal that had reached `complete` therefore kept its full state
in the model context on every later request, and kept its line in the status
bar. Two problems followed.

**The model narrated the goal instead of answering.** A `complete` goal payload
says, in the model's own context, that a goal exists and is done. Faced with an
unrelated follow-up question, the model reliably opened with a sentence about the
goal's completed status — "this goal is already complete, so this is an ordinary
question" — before doing what was asked. Nothing in the prompt asked for that;
it was the presence of the state that produced it.

**The prompt contradicted itself.** `goalPrompt` emitted the plan instructions
unconditionally and only branched on the last line:

```
Next step (first unchecked item in its ## Task checklist): …
Seed your work from its ## Acceptance criteria and check each item off …
…
This goal is not active. Do not resume goal work automatically …
```

The first half told the model to keep working; the last line forbade it. That
was wrong for every non-active status, not only `complete`.

The cost was also real: the injected payload measured ~7,300 characters
(~1,800 tokens) on the session that surfaced this, and `parseVerdict` puts no
length cap on `reason` or `evidence`, so the injected `verdict` text was
unbounded model output. `progress`/`candidate` and `goal.reason`/`verdict.reason`
were byte-identical duplicates, and most of the payload
(`planCriteria`, `verdict`, `progress`, `candidate`, `planPath`) has no use once
the goal can no longer run.

## Decision

Two statuses are terminal, and they are defined as exactly the ones `/goal resume`
already refuses: `complete` and `budget_limited`. `isRetired(goal)` names that
pair, and a retired goal is dropped from both the context injection and the
status bar.

The snapshot itself is kept. `/goal status`, the session entry, and `restore()`
still see the finished goal, so nothing about auditing or history changes — only
the two places that put the goal in front of the model or the user are gated.

The retire condition was deliberately **not** written as `status !== "active"`.
`paused`, `blocked` and `no_progress` still inject, because their closing line
("Only /goal resume or a new user-managed goal starts it") is a decision the
model must respect after a compaction. Only the terminal pair says nothing
beyond "this is over", and that is the whole reason it must not be injected.

`goalPrompt`'s plan instructions now require `status === "active"` as well, which
removes the self-contradiction for every non-active status while leaving the
active path untouched.

## Alternatives considered

**Shrink the payload but keep injecting it.** Trimming the duplicate fields would
have cut the tokens, but the model's compulsion to narrate came from the state
being present at all. A shorter "goal complete" line produces the same opening
sentence. Rejected as treating the symptom.

**Inject a one-line "the previous goal is complete" notice on the first turn
after completion.** Still a goal-shaped statement in context, so it still invites
the same reply — and it needs a "have we told them yet" counter that the
snapshot format does not have. Rejected.

**Clear the goal outright on completion.** Would break `/goal status`, erase the
verdict the user may want to read, and make completion indistinguishable from
`/goal clear`. Retiring keeps the distinction.

**Fold the status into the continuation path only.** `goal-continuation` is sent
by `schedule`, which already requires `active`, so the continuation never had
this bug. The leak was `goal-context`, which is why the fix is there.

## Consequences

A completed goal produces no context entry and no status-bar line, so the next
user request is answered without a preamble about finished work. The status bar
goes blank rather than reading `Goal complete · …`; `/goal status` remains the
way to inspect it, and `/goal clear` still writes its tombstone.

`budget_limited` retires too, which is a behavior change beyond the reported
complaint: a budget-stopped goal no longer leaves a footer. It is grouped with
`complete` because `/goal resume` rejects both, so neither can ever become
active again without `/goal replace`.

Nothing else reads `isRetired`, so a future non-terminal status added to
`GoalStatus` will inject by default. That is the intended default: a status is
retired only once `/goal resume` refuses it.

## Verification

- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/lifecycle.test.ts::a completed goal stops being injected and leaves the status bar`
- `plugins/goal/test/lifecycle.test.ts::a budget limited goal is also retired from context and the status bar`
- `plugins/goal/test/lifecycle.test.ts::a paused goal still reaches the model, since it is resumable`
- `plugins/goal/test/lifecycle.test.ts::a paused goal is not told to work through a plan it must not resume`

Proved: removed the `isRetired` guard from both the `context` handler and
`display`, and restored the unconditional plan lines in `goalPrompt`. Three tests
failed — the completed goal reappeared in `context`, the budget-limited goal did
too, and the paused prompt carried `## Task checklist` again (`36 pass, 3 fail`).
Restoring the guard and the `active` condition returned the suite to green
(`57 pass, 0 fail`).
