# Agent Note: Make the permission approval dialog fail toward denial

Status: implemented

## Problem

The approval dialog is the highest-frequency security interaction in
`pi-permissions`, and it was built so that the reflex answer was the
permissive one.

Two defects, both reproduced:

1. **The dangerous tier led with `Allow once`.** A terminal `select` focuses its
   first option, so the option order *is* the default. `prompt.ts` built
   `[OPT_ALLOW_ONCE, …, OPT_DENY, OPT_DENY_FEEDBACK]` for every tier, so a
   developer confirming a dangerous call with a carriage-return reflex —
   exactly the reflex the rest of the session trains — authorised it. The tier
   that exists to stop force pushes, `rm -rf` and credential reads was the
   cheapest one to wave through.
2. **The dialog flattened the command.** `summarizeInput` collapsed every
   newline to a space and cut at 240 characters with no indication that
   anything had been dropped. A heredoc, a pipeline or a multi-line
   `python -c` arrived as one run-on line, and a command longer than 240
   characters was displayed as a *different* command than the one about to run.
   The one thing the dialog exists for — letting a human see an injection
   before it executes — was the thing it destroyed.

## Decision

**Deny leads on the dangerous tier.** `options` is now built per tier: a
dangerous call offers `Deny`, `Deny and explain to the agent…`, `Allow once`,
and the directory grant; everything else keeps `Allow once` first. The reversal
is deliberately scoped to the dangerous tier — inverting the everyday prompt
would train the opposite reflex and tax every grey call with an extra
keystroke.

**The command is shown as a block, and every elision is stated.**
`formatCommandBlock` keeps up to four of the command's own lines, indents them
by two so they read as a command rather than prose, soft-wraps any line past 80
columns instead of cutting it, and appends either `… N more lines` or
`… N more characters` when anything was left out. `summarizeInput` no longer
pre-slices the text: `formatCommandBlock` is the only place that knows an
elision happened, so it is the only place that can state it.

**The title labels its fields.** `[pi-permissions] <TIER> <tool>` /
`Reason: …` / `Target:` / the block, instead of one run-on line.

Emoji were considered for the header and rejected: this is a terminal surface
whose existing vocabulary is austere, and a siren glyph buys nothing that the
`DANGEROUS` word and the option order do not already say.

## Alternatives considered

- **Keep `Allow once` first but bold it.** Rejected: emphasis does not change
  which option the reflex reaches.
- **Require typing the command to confirm a dangerous call.** Stronger, but it
  changes the interaction cost of every dangerous call and belongs with a
  broader redesign of the prompt surface; recorded as a follow-up instead.
- **Show the full unbounded command.** Rejected: a 50 KB command would bury the
  dialog. Bounded, but with the elision stated.
- **Truncate with a `…` suffix, as before.** Rejected: that is the defect.

## Consequences

- The dialog is taller for multi-line commands, and a long command costs a
  fold marker rather than a silent cut.
- `OPT_DENY_FEEDBACK`'s label changed from `Deny with feedback…` to
  `Deny and explain to the agent…`: the old wording read as "submit feedback
  now", when it opens a second dialog.
- The reviewer payload is unchanged — it still receives the unbounded command
  through `describeInput`.

## Verification

- `plugins/permissions/test/prompt-format.test.ts` — the formatter contract:
  structure preserved, long lines folded without loss, elisions stated in lines
  and in characters, short commands shown whole, pathological input bounded.
- `plugins/permissions/test/plugin.test.ts` — `a dangerous prompt defaults to
  deny, not to the first allow`; `a grey prompt still leads with allow-once`;
  `the dialog labels its fields and shows the command as a block`; `a dangerous
  dialog keeps the tier in its header and still blocks the command`; and the
  rewritten `auto: the reviewer payload stays unbounded while the dialog folds
  explicitly`.
- Red-run proof: `plugins/permissions/test/plugin.test.ts::auto: reviewer sees
  the command past the 240-char display summary` failed against the new
  formatter before its expectation was rewritten, because the old assertion
  pinned the silent truncation.

Proved: plugins/permissions/test/plugin.test.ts::auto: reviewer sees the command past the 240-char display summary failed against the new formatter (the dialog now states its elision instead of cutting silently), which is why that expectation was rewritten rather than kept.
