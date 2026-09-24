# pi-subagent

Delegate **one task** to a named subagent running in its own pi process. The
caller chooses whether to wait for its answer or continue while it runs.

Requires pi **0.85.1 or newer**. From this workspace, install locally with:

```sh
pi install -l ./plugins/subagent
```

## Why a subagent and not a workflow

A subagent and a workflow are different primitives, not two sizes of the same
one:

| | `subagent` | `pi-workflow` |
|---|---|---|
| Question | *do this one thing, here* | *do this large piece of work now* |
| Shape | one delegated task | a script that batches many |
| Context | one isolated child | N isolated children |
| Result | in this tool call by default; completion message in background mode | a background message when it settles |
| Consent | none needed | explicit opt-in by rule |

`subagent` is the single-task path. It waits by default when the next step needs
the answer, or returns a task ID immediately when `background: true` is set.
`pi-workflow` exists for work too wide or too structured for
that, and is deliberately gated behind an explicit opt-in because a fan-out is a
spend decision. Use `subagent` for one delegated task; use a workflow for many.

Neither is a lookup tool. A `grep`/`read` answers most questions directly, and
neither a subagent nor a workflow is worth its cost for those.

## The tool

```jsonc
{
  "agent": "explore",        // built in; no agent file needed
  "task": "Find every place the session store is read, and summarise the callers.",
  "model": "provider/model", // optional; overrides this call's agent definition
  "background": true         // optional; return a task ID immediately
}
```

The subagent starts with a **fresh context**: it cannot see this conversation, so
the `task` must state the goal, the relevant paths, and what a good answer looks
like. Its final text comes back in the tool result (capped at 50 KB to the model;
the full text stays in the tool details). The child's token usage is returned on
the tool result as well in foreground mode. In background mode, the tool returns
a task ID and the answer arrives as a completion message. `subagent_tasks` can
list tasks, show a task's status and answer, or cancel a running task:

```jsonc
{ "action": "list" }
{ "action": "show", "id": "sa-..." }
{ "action": "cancel", "id": "sa-..." }
```

At most four background subagents run at once. Their handles and results remain
in memory for the current session; the most recent 20 settled tasks are kept.
Switching sessions or shutting down cancels active tasks. Completed tasks wake
the parent agent; failures and cancellations appear in the transcript without
starting another turn.

In the TUI, the call shows the selected agent and task. While the child runs,
the result card shows its current tool, file path when available, and completed
tool count; expanding it shows the five most recent activities. Search patterns,
command contents and output are not copied into progress updates. When the child
finishes, the card shows its status and reply preview. The complete reply
remains in the tool result details.

## Built-in agent

`explore` is available immediately after installation. It uses Pi's `read`,
`grep`, `find`, and `ls` tools to inspect the codebase and return concise findings
with file references. It has no write or shell tool. With no model override, the
child uses the parent session's currently selected model. Use it for a bounded
investigation; a direct `grep` or `read` is still cheaper for a simple lookup.

## Custom agents

Agents are markdown files with YAML frontmatter, discovered from
`~/.pi/agent/agents/*.md`:

```markdown
---
name: scout
description: Fast codebase recon; returns compressed context.
tools: read, grep, find, ls
model: provider/small-model
---

You are a scout. Find what was asked for and return only what the caller needs.
```

| Field | Meaning |
|---|---|
| `name` | the value the model passes as `agent` (required) |
| `description` | one line shown when the model needs the list (required) |
| `tools` | comma-separated or YAML list; omit to give pi's default set |
| `model` | persistent override for this agent; omit to inherit the parent session's current model |
| body | the delegated system prompt |

**Only user scope is read.** A project-local `.pi/agents/*.md` would be a
repository-controlled system prompt — installing a plugin is not consent to run
whatever a repository's author wrote — so this first cut does not load project
agents at all. Project scope can be added behind a trust check later.

Discovery runs on every call, so editing an agent file takes effect without a
restart. A user file named `explore.md` with `name: explore` replaces the
built-in definition, including its tool list and prompt. An unknown agent name
returns the available names without launching a child.

Model priority is: `model` on this tool call, then `model` in the agent file,
then the parent session's currently selected model. When neither override is
set, the parent's thinking level is inherited too. The actual model used is
returned in the tool details.

## Isolation and the one-level rule

A subagent is a separate pi process, spawned in JSON mode with `--no-session`.
It gets real tools, real compaction and real provider auth, not a
reimplementation.

Ambient extensions load in the child, so the spawner tells it what it is not. The
child environment is set by `pi-agent-runner`'s `agentChildEnv()`: a child runs
with `PI_GOAL_DISABLE=1`, `PI_WORKFLOW_DISABLED=1` and `PI_SUBAGENT_DISABLE=1`.
It therefore registers no goal surface, no workflow tool, and no `subagent` tool
of its own — **fan-out is one level deep**, so a delegation cannot multiply into
a tree that no single counter bounds. `pi-workflow` spawns its children through
the same function, so the one-level rule is one constant in the shared runner
rather than a contract each plugin re-implements.

A child that dies of a transport failure is not retried: re-running a delegated
task that may already have written is worse than a missing answer. A hung child
is killed by a 15-minute wall-clock cap (`DEFAULT_AGENT_TIMEOUT_MS`).

## Goal accounting

When `pi-goal` is active, a subagent launched during its work run reports its
cache-inclusive token usage to that goal. `pi-workflow` uses the same service for
background runs. A goal budget reacts to usage once a child reports it, so a
running child can overshoot the limit before it finishes. A report from a prior
goal or session cannot charge the current goal.

## Deliberate limits

The first cut is deliberately small. Not implemented:

- parallel and chained modes (several tasks in one call);
- continuing a previous subagent conversation via a session id;
- project-scoped agent definitions.

Each call still starts only one child. Background handles and results live in
the current session's memory and are not resumable after a process restart.

## Development

```sh
bun test
bun run typecheck
```

The child process is run by the workspace library [`pi-agent-runner`](../agent-runner)
(spawn rules, JSON event folding, timeout/abort kill, child environment), shared
with `pi-workflow`. See [ATTRIBUTION.md](ATTRIBUTION.md). A fix to the spawn path
belongs there, and both consumers get it.
