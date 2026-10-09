# Agent Note: Recover restored Bash titles and render concise Paseo states

Status: implemented

## Problem

Restored background jobs all showed `(restored job)` in Paseo. The status card
also repeated `Background command` and displayed `exit unknown` for stopped
jobs. These cards consumed four lines without identifying the command.

## Decision

Recover a job's command from matching Bash tool-result details in the current
session branch. Keep durable job records unchanged and use `Background job`
when no matching result exists. Paseo also normalizes historical placeholder
titles. Render readable state labels, hide generic Bash descriptions and
redundant running/success/unknown-exit text, retain non-zero exit diagnostics,
and place activity and metrics in a wrapping footer with tighter spacing.

## Alternatives considered

- Persist commands again in custom job records: duplicates existing tool
  results and changes the deliberate metadata-only storage contract.
- Read commands from log headers: adds file I/O to restoration and depends
  on logs that may already have been pruned.
- Fix only the card title: keeps restored task inspection unable to identify
  the command and does not improve new status publications.

## Consequences

Existing records remain compatible. No command or output is added to durable
metadata. Restoration reads only the current branch, accepts command strings
only from Bash tool results, and never treats a restored process as live.
Records lacking matching results retain an honest generic title. Timeline
events remain separate cards; this change does not merge task history.

## Verification

- `plugins/bg-bash/test/records.test.ts` covers command recovery from a matching
  Bash result and fallback when no result exists.
- `integrations/paseo-ui/test/card.test.tsx` covers readable terminal states,
  historical titles, hidden redundant lines and preserved failure diagnostics.

Proved: before implementation, running both bound files reported 3 failures:
the restored command remained `(restored job)`, the stopped card lacked
`Stopped`, and the existing budget-label assertion lacked `Budget reached`.
After implementation the same command reports 5 pass and 0 fail.
