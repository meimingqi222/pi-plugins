# Agent Note: Respect gitignore before building ACE upload inventory

Status: implemented

## Problem

ACE applied only configured exclusions. A private JSON file named in the
project's .gitignore still entered the upload body and retrieval hash list.

## Decision

Read root and nested .gitignore files while walking, using the directly declared
ignore runtime dependency. Each matcher is relative to its own directory;
deeper explicit matches override ancestor file rules. Ignored directories are
pruned, so a nested negation cannot reopen an excluded parent. Configured
EXCLUDE_PATTERNS remain an independent additional filter with unchanged semantics.
Errors reading an existing ignore file fail the search rather than upload blindly.

## Alternatives considered

Replacing the existing configured-pattern matcher would change acemcp-compatible
semantics. Calling Git would require an installed executable and a repository.
Filtering only upload bodies would still request excluded cached hashes.

## Consequences

Both upload bodies and retrieval hashes exclude ignored files, even outside
Git repositories. Global excludes and .git/info/exclude are outside this scope.
This prevents future selection; it does not delete data uploaded previously.

## Verification

- `plugins/ace-search/test/search.test.ts`
- `plugins/ace-search/test/search.test.ts::gitignore rules exclude upload bodies and retrieval hashes with nested overrides`

Proved: before the fix, the new test failed because private.json, secret.local.json,
nested/hidden.json and private/keep.ts were uploaded. After the fix it passes,
retaining the rooted-pattern lookalike and explicitly re-included nested file.
