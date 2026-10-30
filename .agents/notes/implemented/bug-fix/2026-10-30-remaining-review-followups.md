# Agent Note: Close the remaining review follow-ups

Status: implemented

## Problem

Seven follow-ups from the first review round, none of them exotic and each with
a concrete failure:

1. **`run-core`'s snapshot restore called `getBranch()` unguarded**, while
   `DeliveryLedger.pending` wrapped the identical call. A session manager torn
   down under `session_start` threw inside the handler and took the restore with
   it, leaving the status bar and the context on stale state until the next
   boundary.
2. **`pi-goal` wrote the plan with a plain `writeFile`**, which truncates in
   place. A crash mid-write left a half checklist the next run read as progress.
3. **`pi-bg-bash` swallowed a log-stream error** (`stream.on("error", () =>
   stream.destroy())`), then kept advertising `Full output: <path>`. A disk that
   filled mid-build produced a job that "succeeded" whose log stopped early, and
   a model reading it reported tests as passing.
4. **`sweepLogDir`'s count cap reached into unexpired logs.** After the age
   sweep it unlinked anything past `MAX_LOG_FILES`, newest kept — and the
   survivors are by definition unexpired, so the cap could only ever delete a
   live log. A second pi process holding two hundred older logs made a new
   session's sweep take the oldest, and a *quiet* job — running, but not writing,
   so its mtime looked old — lost the file its notice still pointed at.
5. **The sandbox's `denyRead` was a second, narrower credential list.** It named
   the roots and `~/.pi/agent/auth.json`, and omitted `~/.npmrc`, `~/.netrc`,
   `~/.pypirc`, `~/.git-credentials` and `~/.docker` — so the strictest mode the
   plugin has could read an npm token.
6. **PowerShell redirects were parsed and then ignored.** `analyzePowerShell`
   recorded them, `powerShellPathIntents` never read them, and the parser only
   recognised `>` and `>>`. `echo pk > ~/.ssh/authorized_keys` through the
   `powershell` tool graded as `Write-Output` — safe, read-only.
7. **`native-timeline-style.ts`'s `marginHorizontal: -13`** was an unexplained
   magic number tied to a host padding the SDK does not expose.

## Decision

**1 — guard the call.** `try { … } catch { return undefined; }`, matching the
ledger. "No snapshot" is the honest answer when the branch cannot be read.

**2 — temp file then `rename`.** Atomic on the same filesystem, so a reader sees
the old plan or the whole new one, never half of one. The staging path sits
beside the target so the rename cannot cross filesystems.

**3 — surface the loss.** `startCommand` returns `logLost()`, the job carries the
flag once the run settles (read after `finish` closes the stream, so a mid-run
failure is visible), and every reader that pointed at the path now says the log
is unavailable instead: the background notice, `formatJobStatus`,
`formatResult`, and `detailsFor`'s `logPath`/`fullOutputPath`, which drive the
TUI's "Full output" affordance.

**4 — the cap no longer reaches unexpired files.** It now trims only when
retention could not bound the directory, which is the one case the age rule
cannot cover, and it takes the oldest — which a job writing to its log escapes
by definition, because output moves its mtime to the front. `MAX_LOG_FILES` is
documented as a ceiling for that case rather than a second deletion rule.

**5 — one list.** `CREDENTIAL_MASK_PATHS` in `path-policy.ts` is the credential
roots plus the standalone credential files that live outside them, and the
sandbox derives its `denyRead` from it. User-configured `settings.denyRead` still
appends.

**6 — redirects are writes.** The parser recognises every PowerShell redirect
operator (`>`, `>>`, and the stream-qualified `N>`, `N>>`, `*>`, `*>>`; `<` is
not a PowerShell operator and is not pretended to be), `powerShellPathIntents`
turns each target into a write intent, and a recursive enumeration of a
credential root is graded like the bash side grades `grep -r` against one.

**7 — the derivation, not the value.** `RAIL_PADDING`, `COLUMN_PADDING` and
`COLUMN_MAX_WIDTH` are exported, the host's row inset is a named constant, and
the compensation is their difference. The rendered output is unchanged: this
environment cannot render Paseo, and silently changing a pixel alignment that
currently matches the host would be a worse trade than making it checkable.

## Alternatives considered

- **Delete the count cap outright.** Rejected: with a long retention the age rule
  alone leaves the directory unbounded, and that is the case the cap is for.
- **Track open log descriptors across sessions.** Rejected: not portable — there
  is no `lsof` on Windows and `/proc/*/fd` is Linux-only.
- **Make the sandbox keep its own list but longer.** Rejected: that is the defect.
  Two lists drift, and the drift was in the direction of reading a token.
- **Fix the narrow-pane overflow by clamping the margin.** Rejected for now: the
  style is static and the item props carry no width, so a clamp would change the
  alignment on the panes that currently look right. Recorded as a follow-up
  instead, with the arithmetic pinned by a test.

## Consequences

- A log that dies mid-run is reported as unavailable rather than pointed at. The
  in-memory tail is still shown, so the model sees output either way — it just
  cannot believe it saw all of it.
- The log directory is bounded by retention; the count ceiling only applies when
  retention is too long to bound it.
- The sandbox masks five more credential locations, which may break a command
  that legitimately read `~/.npmrc` inside the sandbox. That is the correct
  trade for the strictest mode, and `settings.denyRead` remains the escape
  hatch in the other direction.
- PowerShell commands that redirect into a credential path are now dangerous,
  which is a behaviour change for anyone who relied on them being waved through.

## Verification

- `plugins/permissions` — 174 tests, including the new sandbox and powershell
  grading; probed with the same one-liner matrix used for the bash side, which
  is how the `>`-only regex bug was caught (see `Proved`).
- `plugins/bg-bash`, `plugins/goal`, `plugins/run-core` — existing suites green.
- `integrations/paseo-ui/test/native-timeline-style.test.ts` — the compensation
  is the difference of the two insets, the tokens in use are the ones the
  derivation rests on, and a card at the widest column still fits the rail.
Proved: `regression-evidence/powershell-redirect-red.txt` — with the redirect intents removed and the `>`-only regex restored, `echo pk > ~/.ssh/authorized_keys` grades `grey` with no rule id and `Write-Output x *> ~/.aws/credentials` grades `safe`. The probe matrix that caught it lives in this note's Verification section because the suite did not: a regex that stops matching a bare `>` one character from the fix is exactly the shape of bug a green suite hides.
