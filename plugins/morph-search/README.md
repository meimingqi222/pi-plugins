# pi-morph-search

Small Morph extension for two tools: `warpgrep_codebase_search` and
`warpgrep_github_search`. It has no Fast Apply tool, no routing hook, and no
`before_agent_start` handler. Morph compaction is optional and disabled by default.

Install this workspace package with `pi install -l ./plugins/morph-search`, then
remove `npm:pi-morph-plugin` from your pi package list. Do not load both: they
register the same search tool names.

Configuration lives in `~/.pi/agent/morph-search.json` (or the path named by
`PI_MORPH_SEARCH_CONFIG`):

```json
{
  "apiKey": "your Morph API key",
  "compact": {
    "enabled": false,
    "ratio": 0.3,
    "preserveRecent": 1
  }
}
```

`apiKey` can alternatively come from `MORPH_API_KEY`. The file wins when both
are set. Optional keys: `baseUrl`, `searchTimeoutMs`, and
`compact.timeoutMs`. Config is read on extension load, so `/reload` applies edits.

Compaction returns `undefined` when Morph fails or returns an empty summary,
allowing pi's normal compaction to run. Results from both search tools are
truncated to pi's standard tool output limits. The tools use Morph's SDK; this
package does not send data to Morph until a search runs or enabled compaction
occurs.
