# Agent Note: Block detected unsafe native summaries instead of assuming provider-hook coverage

Status: implemented

## Problem

Pi 1.0.0 attaches `before_provider_request` to Agent.onPayload. Native compaction
and branch summaries invoke the stream function directly, so stored user secrets
can bypass both that hook and context redaction. The old documentation incorrectly
claimed the hook wrapped every stream invocation. Tool-result sanitization does
not protect secrets in stored prompts, previous summaries or manual instructions.

## Decision

The preparation hooks in `plugins/redact/src/index.ts` inspect exposed summary
inputs and cancel on a detected secret or inspection error. Inspection uses Pi's
public conversion/serialization helpers, so text blocks joined by Pi and tool
arguments are checked as the summarizer sees them. Tree inspection prepares all
entries with an unlimited budget rather than duplicating model routing.

Clean and paused handlers return undefined. They do not mutate history, take
over generation, or overwrite another compactor's return value. Cancellation
remains effective even when the UI cannot display the warning.

## Alternatives considered

**Mutate preparation and continue.** Manual customInstructions is held in a
separate Pi local; mutation does not transform it. Tree instruction overrides
also compete with other handlers' results, which Pi replaces rather than merges.

**Generate the summary here.** Duplicates Pi's model routing, authentication,
budgeting and retry behavior, and turns a redactor into a competing compactor.

**Intercept global fetch or private stream state.** Breaks independent outbound
traffic and relies on internals; the existing service remains the explicit
boundary for cooperating extensions.

## Consequences

Detected unsafe attempts are blocked, not redacted. The guard can cancel custom
compaction too and can conservatively block branch text excluded by the eventual
model budget. Earlier extensions may already have sent requests; later handlers
can introduce inputs invisible to this check. This is not a universal outbound
guarantee. Ordinary tree navigation is unchanged, and explicit pause permits
unprotected summaries. Public provider hooks retain their documented fail-open
policy. The README names these boundaries instead of promising complete coverage.

## Verification

- `plugins/redact/test/native-summary.test.ts::Pi native compaction blocks stored secrets`
- `plugins/redact/test/index.test.ts::blocks exposed native-summary secrets`
- `plugins/redact/test/index.test.ts::native-summary inspection errors`

Proved: before the guard, the real SDK test completed native compaction instead
of blocking it, and the preparation tests returned no cancellation. Actual red
output is saved in `.agents/notes-evidence/2026-10-19-redact-sdk-summary-red.txt`
and `.agents/notes-evidence/2026-10-19-redact-boundaries-red.txt`. After the fix,
the SDK test observes zero summarizer calls, then proves generation still works
after explicit pause. Both extension load orders preserve a clean custom summary.
