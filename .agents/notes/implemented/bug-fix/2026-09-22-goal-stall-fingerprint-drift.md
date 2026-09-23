# Agent Note: Fold high-entropy tokens out of the stall fingerprint

Status: implemented

## Problem

The stall guard compares each verifier `nextAction` against the previous one
after folding case, punctuation and whitespace. Two rounds that ask for the same
work in the same words trip it after `PI_GOAL_STALL_RUNS`; a reworded request
that names genuinely new work does not.

That fold kept every alphanumeric token, including tokens that change on every
attempt. A verifier that names a scratch path, a uuid or a generated id produced
a different fingerprint each round for what was the identical request:

```
"fix the failing test in tmp grok goal a1b2c3d4e5f6 out log"
"fix the failing test in tmp grok goal 9f8e7d6c5b4a out log"
```

The guard could therefore never fire on exactly the stuck loop it exists to
catch, and the goal ran to the run cap instead — the expensive backstop that the
stall check is supposed to preempt. The two guards are ordered so that the stall
exit is meant to be the cheap, primary stop; a drifting fingerprint silently
demoted it to unreachable.

The reachability argument is direct: this plugin's verifier is a model, and
models routinely name a scratch path or an id in a next action. Nothing filters
those tokens before the fold, so the drift is a property of the code rather than
of a particular run. The end-to-end test constructs exactly that sequence.

## Decision

`nextActionKey` folds high-entropy tokens before stripping punctuation, so the
normalisation applies to the token as written rather than after it has been
split apart:

- scratch roots (`/tmp/…`, `/private/tmp/…`, `/var/folders/…`) collapse to
  `scratch`;
- a canonical 8-4-4-4-12 uuid collapses to `id`;
- any run of 12 or more hex characters collapses to `id`, covering a git sha or
  a hex id without a special case.

The 12-character floor is the load-bearing part. Shorter hex runs are ordinary
English — `decaf`, `facade`, `defaced` are all spelled from `a`–`f` — so folding
them would merge unrelated actions. Twelve is long enough that a real word
cannot reach it and short enough to catch a truncated sha.

Plain integers are deliberately **not** folded. `Run test 3` and `Run test 4`
name different work, as do the line numbers in `src/a.ts:41` and `src/a.ts:42`.
Folding digits would make a progressing goal look stalled, which is the opposite
failure and strictly worse: it stops work that was converging. A fingerprint is
only useful if it is stable across volatile tokens *and* sensitive to
meaningful ones, so both directions are pinned by tests.

## Alternatives considered

**Hash the whole string instead of normalising it.** A hash is exactly as
sensitive as its input, so it inherits the same drift. It also throws away the
readable fingerprint, which is what `nextActionKey` is persisted as and what
makes a stalled goal diagnosable from the snapshot.

**Fold all digits.** Catches ids and attempt counters, but collapses numbered
steps and line numbers. Rejected as trading a missed stall for a false stall.

**Let the verifier return a stable action id alongside its prose.** Cleanest in
principle, but it makes the fingerprint the model's responsibility: a model that
omits or renumbers the id reintroduces the drift, and the prompt would have to
enforce it. Normalising in the harness is a property of the code rather than of
the model's compliance.

**Lower the run cap so the backstop is cheap enough not to matter.** Treats the
symptom, and the cap is the guard that costs a full work run per round — exactly
what the stall exit exists to avoid paying.

**Normalise every path, not just scratch roots.** A workspace path is stable
across rounds and can identify the gap, so folding it would lose signal for no
gain.

## Consequences

A verifier that re-litigates the same request in different words now pauses as
`no_progress` on the second identical fingerprint even when its wording carries
a fresh scratch path or id, which is what the README already claimed it did.

The fingerprint remains readable in the snapshot, so a stall is still
diagnosable. `nextActionKey` gained a unit test file of its own
(`test/state.test.ts`) since it is now non-trivial enough to have two failure
directions, and the existing "a reworded next action counts as progress" test
still passes unchanged — the fold did not become lossy where it matters.

## Verification

- `plugins/goal/test/state.test.ts`
- `plugins/goal/test/lifecycle.test.ts`
- `plugins/goal/test/state.test.ts::a per-attempt scratch path folds to one fingerprint`
- `plugins/goal/test/state.test.ts::a uuid or generated id folds to one fingerprint`
- `plugins/goal/test/state.test.ts::plain integers and line numbers still distinguish work`
- `plugins/goal/test/state.test.ts::ordinary words are not mistaken for ids`
- `plugins/goal/test/lifecycle.test.ts::a next action whose only change is a per-attempt token still stalls`
- `plugins/goal/test/lifecycle.test.ts::a next action naming a different numbered step is not a stall`

Proved: restored the old `nextActionKey` (punctuation fold only). Three tests
failed — the scratch-path and uuid fold tests, and the end-to-end
per-attempt-token test, which reached the run cap instead of `no_progress`
(`62 pass, 3 fail`). The two "distinguishes work" tests stayed green in that
run, so they are not vacuous. Restoring the normalisation returned the suite to
green (`65 pass, 0 fail`).
