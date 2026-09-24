# Agent Note: Morph search without prompt replacement

Status: implemented

## Problem

The installed `pi-morph-plugin` registered Fast Apply and a `before_agent_start`
handler that returned a complete `systemPrompt` for routing hints on every new
user turn. That bypassed pi's structured prompt delta path and could disrupt
provider prompt caching. Its compaction hook was also enabled by default and
configured through environment variables. The desired use is only local code
search and public GitHub search.

## Decision

Provide a separate `pi-morph-search` package with exactly those two WarpGrep
tools. Tool guidelines use pi's structured prompt mechanism. The extension
does not register `before_agent_start` and has no edit tool. Read the API key
and compaction options from `~/.pi/agent/morph-search.json`; compaction is off
unless `compact.enabled` is explicitly true. Missing Morph credentials surface
when search is called, rather than disabling pi startup.

## Alternatives considered

Patching the installed npm package would be lost on update and would leave its
Fast Apply implementation loaded. A second extension that clears the forced
prompt would depend on extension load order and still register unwanted tools.

## Consequences

The official package must be removed from pi's package list to avoid duplicate
tool names. The two search tools retain their names. Enabled compaction still
uses Morph's API and falls back to pi when the API fails. The separate config
file keeps this package independent of the old Morph settings.

## Verification

- `plugins/morph-search/test/plugin.test.ts` — checks that only the two search
  tools register, no prompt hook exists, and compaction is opt in.

Proved: temporarily changed `if (config.compact.enabled)` to `if (true)`;
`bun test plugins/morph-search/test/plugin.test.ts` exited 1 and the default
registration test failed. Restored the condition; all plugin tests pass.
