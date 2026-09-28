# Agent Note: pi-permissions reviewer judges machine effects, not the user's goal

Status: implemented

## Problem

Two misjudgments from the same incident — a read-only `python3` hexdump of a
locally installed binary, run while the user's stated goal was removing that
tool's enterprise-account restriction:

1. **Scope.** The deny criterion ("clearly unrelated to the user's request, or
   looks malicious") invited the model to judge the user's goal rather than the
   call's effect. jev answered `deny (p=0.42)` — its own probabilities show it
   was guessing — for a command that only read a file and printed hex. The
   plugin's threat model is destructive / credential / irreversible effects on
   this machine; legality or a third party's terms are not its business. The
   allow criterion compounded it: "effects stay inside the workspace" reads as
   covering reads, so file reads outside the workspace could never be allowed
   even though reads have no effects.
2. **Fidelity.** The reviewer payload flattened the command to one line:
   newlines became spaces, so an embedded heredoc program arrived with its
   block structure erased (`def foff(eo): return eo + 0x1000 …`), which reads
   as unparseable code.

## Decision

Both reviewer prompts — jev's `instructions`/`criteria` in
`plugins/permissions/src/jev.ts` and the registry backend's SYSTEM_PROMPT in
`plugins/permissions/src/reviewer.ts` — now state: judge what the call does on
this machine, not whether the user's goal is legal or allowed by a third
party's terms; for interpreter invocations (python, node, sh -c, heredocs)
judge the embedded program's effects; when torn between ask and deny, answer
ask. Allow explicitly includes reads inside or outside the workspace; deny
narrows to "would damage this machine, leak credentials or secrets, or is
clearly unrelated to the user's request".

`plugins/permissions/src/prompt.ts` splits `describeInput` (control characters
stripped; newlines and tabs kept; unbounded — the reviewer's input) from
`summarizeInput` (one line, 240 chars — the dialog), and
`plugins/permissions/src/index.ts` sends `describeInput` to the reviewer.
Credential reads stay out of the reviewer's reach anyway: they are dangerous
tier and never reach it, so a permissive read rule cannot leak secrets.

## Alternatives considered

**Use jev's probability as a threshold (demote low-confidence deny to ask).**
Both verdicts prompt the user identically, so it changes nothing but the
wording; and treating a reported probability as calibrated would be fake
precision.

**Keep "looks malicious" and rely on the model's judgment.** The incident shows
the pull: a goal that smells like license circumvention reads as malicious even
when the command is a hexdump. The plugin cannot adjudicate the user's goals,
so the prompt must not ask it to.

**Flatten for the reviewer too, as before.** JSON payloads carry newlines
safely, and block structure is exactly the evidence a judge needs for embedded
code.

## Consequences

The reviewer now answers about effects, so routine investigation commands
(reads anywhere, interpreter one-liners) can be released without a prompt,
while destructive and credential calls still never reach it. Whether a goal is
permitted by some third party is out of scope for this plugin by construction.
The two prompt copies must be kept in sync; the tests pin the scoping sentences
in each.

## Verification

- `plugins/permissions/test/reviewer.test.ts` — "the jev question scopes the
  judgment to machine effects" pins jev's `instructions`/`criteria`; the
  registry payload test pins the matching SYSTEM_PROMPT sentences.
- `plugins/permissions/test/plugin.test.ts` — "auto: the reviewer payload keeps
  the command's newlines" pins the heredoc layout in the payload, and "auto:
  reviewer sees the command past the 240-char display summary" pins that the
  dialog stays bounded.

Proved: with `plugins/permissions/src/` stashed (HEAD's criteria and flattened
payload), both new tests fail — `1 fail` each. Restored,
`bun test plugins/permissions/test/` reports 110 pass, 0 fail.
