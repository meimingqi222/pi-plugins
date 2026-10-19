# Agent Note: Bound the pi-ace-search retrieval result

Status: implemented

## Problem

`renderResult` returned `formatted_retrieval` verbatim. ACE sends as much
context as it has (`max_output_length: 0` in the request), and the plugin put
it straight into the tool result. A 5 MB response became a 5,000,021-character
tool result; one retrieval could blow the model's context window. The sibling
`pi-morph-search` already used pi's `truncateHead`, so the two plugins
disagreed about the same hazard.

## Decision

Wrap the body plus stats block in `truncateHead` with pi's `DEFAULT_MAX_BYTES`
and `DEFAULT_MAX_LINES`, and append `[Output truncated]` when the result was
cut. The stats block is included in the bounded text so the model still sees
why a run was slow.

## Alternatives considered

**Set a non-zero `max_output_length` on the request.** Server-side behaviour
is not guaranteed for every ACE deployment, and a proxy or a different
version could ignore it. A client-side bound is the guarantee.

**Truncate only the retrieval body.** The stats block is small but it is part
of the same result; bounding the assembled string is simpler and keeps the
marker meaningful.

## Consequences

Large retrievals are cut at pi's standard limits, the same as the built-in
tools. Small results are unchanged, including the stats block.

## Verification

- `plugins/ace-search/test/render.test.ts` — "a huge retrieval body is
  truncated" (5 MB input, output under 100 KB, marker present) and "a small
  result is unchanged".

Proved: with `plugins/ace-search/src/index.ts` restored, `renderResult` is not exported
and the test file fails to import it; the old behaviour was measured at
5,000,021 characters passed through unchanged.
