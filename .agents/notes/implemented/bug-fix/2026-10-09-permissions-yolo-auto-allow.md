# Agent Note: YOLO bypasses classifier-generated confirmation

Status: implemented

## Problem

The default mode was named yolo, but the dangerous-tier branch ran before
mode selection and always asked. Dynamic file operands, xargs input, credential
search roots and many ordinary maintenance commands therefore opened approval
dialogs; delegated children converted these asks into denials. The reported
`git ls-files -o --exclude-standard | xargs grep -lI 'name'` command was classified
as dynamic-path/dangerous and could not run unattended despite YOLO.

## Decision

YOLO automatically permits safe, grey and dangerous classifications. Keep
classification conservative: the same command still asks in ask/auto modes.
The forbidden floor and explicit user deny rules remain first; explicit ask
rules still tighten YOLO. Dangerous calls explicitly requested by an ask rule
retain the no-session/no-always prompt behavior. Parent and inherited child
modes share the same decision function; no classifier prompt or reviewer runs
for an ordinary YOLO call.

Move existing dangerous confirmation tests to guarded modes rather than
removing them. Update the mode table and documented contract. Other modes,
classification rules, explicit rules and fail-closed handler-error behavior
are retained.

## Alternatives considered

- Special-case only git-ls-files piped to xargs: addresses one example while
  leaving the same unwanted confirmation behavior for many other commands.
- Make unresolved paths safe: loses conservative classification in ask/auto.
- Remove all explicit restrictions: the user requested almost all operations
  to run automatically; forbidden operations and user-configured rules are
  retained as the small, explicit exceptions.

## Consequences

Default YOLO does not prompt on dynamic paths or dangerous classification.
Guarded modes continue to offer confirmation; user ask/deny rules can deliberately
restrict YOLO. Dangerous classification is diagnostic data rather than a
universal approval requirement. Existing running Pi processes must reload the
extension to use this decision; reloading the Paseo UI alone does not update it.

## Verification

- `plugins/permissions/test/decide.test.ts` covers the reported xargs pipeline,
  dynamic reads/deletes, force push and publication: allow in YOLO, ask in
  ask/auto, explicit ask/deny precedence, and unchanged forbidden cases.
- `plugins/permissions/test/plugin.test.ts` covers default parent and inherited
  child YOLO execution without UI/reviewer, guarded prompts and inherited ask
  denial, as well as forbidden rejection.
- `plugins/permissions/test/security-boundaries.test.ts` keeps the conservative
  HOME, dynamic-path, grep-family and deletion classification tests in guarded
  mode; literal HOME remains an ordinary YOLO operation.

Proved: before the decision change, the two new focused YOLO tests both failed
(0 pass / 2 fail): the xargs command returned ask and an explicit ask rule was
not identified as the reason for confirmation. After the change the complete
permissions suite passed 138 tests. Existing dangerous-mode expectations were
updated to the authorized YOLO contract; prompt tests now explicitly select
ask/auto rather than depending on an implicit YOLO confirmation floor.

Final verification: `bun run typecheck`, `bun run test` (1448 pass / 0 fail across
13 packages), and `bun run notes` all passed. A read-only reproduction using the
reported command now returns dangerous/dynamic-path with action allow in YOLO.
