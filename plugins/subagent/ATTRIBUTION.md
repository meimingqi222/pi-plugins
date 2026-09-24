# Attribution

`pi-subagent`'s agent discovery follows **pi's own bundled
`examples/extensions/subagent`** (`@earendil-works/pi-coding-agent`): the
frontmatter shape (`name`, `description`, `tools`, `model`, body), the
`~/.pi/agent/agents/*.md` location, and the "spawn pi in JSON mode" pattern.
`src/agents.ts` is a reduced version of that example's `agents.ts`.

The child-process runner is **not** local. It is the workspace library
`pi-agent-runner`, shared with `pi-workflow`, which carries the spawn rules (a
closed stdin, a wall-clock kill, a continuous stdout drain, the one-level
fan-out environment) and the JSON event folding. That library's provenance is
recorded in `plugins/workflow/ATTRIBUTION.md`: it ports from
[Step-Code](https://github.com/stepfun-ai/Step-Code), MIT.

Splitting the runner out is deliberate: this workspace's plugins must each
install alone, so neither plugin may depend on the other, and the process code
is subtle enough (it has hung a real session) that two copies would drift. The
runner is a library with no `pi` manifest, so depending on it does not pull in a
sibling plugin.
