# Agent Note: Make the workflow API authorable, and let a run be saved

Status: implemented

## Problem

The engine worked and a model could not comfortably use it. Two gaps, both at the
seam between "the capability exists" and "someone can reach it".

**Nothing taught the script API.** The tool description named `agent()`,
`parallel()`, `pipeline()` and `phase()` and said nothing about what a script
*is*: that it is the body of an async function, that `return` is the run's value,
that `args` is the input, that `budget` and `meta` exist, or what
`agent()`'s options are. Step-Code teaches exactly this in its tool description —
a paragraph on `agent(prompt, {schema})` forcing structured output and retrying
schema mismatches, another on determinism. A model asked to "use a workflow" on
pi-workflow had to guess the shape of the thing it was writing, and a guess that
is wrong costs a run.

**A saved workflow could only be created outside pi.** `name` resolved a script
from `.pi/workflows/saved/`, and no command or tool wrote one there. So the
"reusable workflow" half of the feature was read-only: the user had to leave pi,
create the file by hand, and come back. The journal already persists the script a
run executed, so the material for the missing verb was on disk the whole time.

## Decision

**State the contract where the model reads it.** Four guidelines now document the
script surface: what a script is and which globals exist; `agent()`'s options and
which `toolProfile` values are read-only; the difference between the `parallel()`
barrier and `pipeline()` and the `null`-on-throw rule; and that a script worth
re-running can be promoted. This is the one place a model always sees, so it is
where the contract belongs — not in a README it may not open.

**`/workflows save <name> [--user]`.** `promoteWorkflow` copies the chosen run's
persisted `script.js` into the saved set, defaulting to the newest run and
accepting a `runId`. It copies the run's own text rather than re-resolving a
source path, because that text is what produced the run and a path may have
moved. It refuses an existing name instead of overwriting, because a saved
workflow may have been edited on purpose after the run it came from. The user
scope writes under `~/.pi/workflows/saved`, with the home root injectable so a
test never touches the real one.

**An end-to-end test of the whole documented surface.** One script uses `args`,
`meta`, `phase()`, `log()`, `budget`, `parallel()`, `pipeline()` and a
schema-validated `agent()` call, and runs through the real worker with a process
actually spawned at the bottom. The documentation and the test are the same
claim, so a guideline that describes behavior the engine does not have fails
here rather than in a user's first run.

## Alternatives considered

**Ship a bundled workflow, as grok-build ships `deep_research.rhai`.** It would
make the plugin immediately demonstrable with `workflow({ name: "review-panel" })`.
It also adds a maintained product surface — a name that must keep working, listed
and versioned — to solve a problem the guidelines solve more cheaply. The
end-to-end test gives the same proof that the API composes, without the
commitment; if a builtin is wanted later it is a third candidate path in
`resolveWorkflowSource` plus a listing entry.

**Put the script contract in a `docs/` file and point at it.** The pointer would
have to be an absolute path into the installed package, which differs per install
and is neither stable nor discoverable. Step-Code's answer — teach it in the tool
description — has no such dependency.

**Let `save` derive the name from the run.** `readRunSummary` already derives a
name from the script's leading comment (`readScriptName`), so `/workflows save`
with no name looks possible. It is not usable: the derived text is the comment's
first line, which for a real script is a sentence with spaces and slashes, not a
filename. Requiring the name is one word more to type and has no wrong answer.

**Overwrite an existing saved workflow.** Friendlier for the edit-run-save loop,
and it silently destroys a hand-edited script. The error names the target path so
the user can delete it deliberately.

## Consequences

A first use no longer requires reading the plugin's source, and a workflow worth
keeping is one command away from being reusable. The loop is complete: author
inline, run, inspect with `workflow_status`, promote with `/workflows save`, and
invoke by name thereafter.

The guidelines grew by four entries, so every session that has the tool active
carries that text. It is a real cost — prompt budget is not free — and it is paid
because the alternative is a model that cannot write the thing the tool takes.

`promoteWorkflow` lives in `script-source.ts`, which now both resolves saved
scripts and writes them. That file is where saved workflows live, so the
placement is defensible, but a second writer would make a separate module the
right call.

Saving is a copy, not a link. Editing the saved script afterwards has no effect on
past runs and vice versa, which is the intended direction: a run is reproducible
from its own `script.js` regardless of what happens to the saved copy.

## Verification

- `plugins/workflow/test/script-source.test.ts` — the resolution boundary
  (exactly one source, path containment, the size cap, the saved-name allow-list)
  and promotion (round-trip to resolution by name, refusal to overwrite, no run
  to promote, a named run rather than the newest, the injected user home)
- `plugins/workflow/test/end-to-end.test.ts` — `the documented script contract >
  every documented global works together, through a real spawned agent`

`248 pass, 0 fail` for the workflow package; `bun run typecheck` clean.

Proved: three red runs.

- **`COPYFILE_EXCL` dropped from the promoting copy.** It failed
  `promoting a run to a saved workflow > refuses to overwrite a saved workflow
  that already exists` with `Expected promise that rejects` — so the test pins the
  refusal rather than the copy.
- **`pipeline` removed from the worker's exposed globals.** It failed
  `the documented script contract > every documented global works together,
  through a real spawned agent` with `Expected: "completed"`, because the script
  threw on the name the guidelines promise. This is the assertion that the
  documentation is executable.
- **The budget spend no longer returned with an agent result.** It failed the
  same test with `Expected: 99964, Received: 100000` — the script read the value
  captured before any agent ran, so the test pins that `budget` reports real spend
  rather than merely existing.

Restoring each returned the suite to green.
