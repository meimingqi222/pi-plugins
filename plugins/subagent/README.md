# pi-subagent

Delegate **one task** to a named subagent running in its own pi process. The
caller chooses whether to wait for its answer or continue while it runs.

Requires pi **1.0.0 or newer**. From this workspace, install locally with:

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

The public arguments use `subagent_type` and `prompt`; old `agent`/`task` calls
are normalized before validation. Host results include `agentId`, `status`
(`error` for failure), and `nativeStatus`. Independent hidden `subagent-update`
messages keep Paseo cards synchronized on completion, failure, cancellation
and replies, even when the parent already read the answer. Raw RPC logs remain
available through `subagent_tasks`; they are not advertised as pi session files.
Reload pi to load the updated schema. Old recorded launches are not rewritten.

```jsonc
{
  "subagent_type": "explore",        // built in; no agent file needed
  "prompt": "Find every place the session store is read, and summarise the callers.",
  "model": "provider/model", // optional; overrides this call's agent definition
  "background": true         // optional; return a task ID immediately
}
```

The subagent starts with a **fresh context**: it cannot see this conversation, so
the `prompt` must state the goal, the relevant paths, and what a good answer looks
like. Its final text comes back in the tool result (capped at 50 KB to the model;
the full text stays in the tool details). The child's token usage is returned on
the tool result as well in foreground mode. In background mode, the tool returns
a task ID and the answer arrives as a completion message. `subagent_tasks` can
list tasks, show a task's status and answer, or cancel a running task:

```jsonc
{ "action": "list" }
{ "action": "show", "id": "sa-..." }
{ "action": "events", "id": "sa-...", "limit": 5 }
{ "action": "log", "id": "sa-...", "query": "tool_execution", "lines": 20 }
{ "action": "cancel", "id": "sa-..." }
{ "action": "wait", "id": "sa-...", "timeout": 30 }
{ "action": "reply", "id": "sa-...", "prompt": "also check the retry path" }
{ "action": "reply", "id": "sa-...", "prompt": "stop what you're doing", "interrupt": true }
```

`wait` blocks up to `timeout` seconds (default 30, maximum 300) for the task to
settle and returns its record either way — the supported alternative to polling
`show` in a loop. An interrupted call returns at once and says so; only a
deadline that actually elapsed reports an elapsed time.

### Result delivery and proactive inspection

A child's `agent_settled` makes its answer available immediately, independently
of whether the parent is busy and whether the child process is still alive.
Each new answer has a `resultRevision`; a new terminal failure also advances it,
while process exit repeating a settled outcome does not.

- When the parent is idle, an unread success or failure starts a follow-up.
- When the parent is running, unread answers enter Pi's native steering queue
  at the parent's `turn_end`, after the entire tool batch has returned and
  before the next model call. They do not have to wait for the run to finish.
- Results arriving after the run's last `turn_end` stay pending until `agent_settled`;
  an unread success or failure can then start a follow-up. Cancellation remains
  context-only, without requesting a new run. Failure is delivered through the
  native queue rather than only appended to history, so the parent can actually
  account for it before claiming success.
- `show` and `wait` returning an answer consume its pending notification.
  `log` also appends the latest canonical settled answer when available and
  consumes that revision, even when its raw-log preview is truncated or
  unavailable. The appended answer uses the same 50 KB model-facing bound as
  the normal result, separate from the raw-log preview's 32 KB bound.
- Reading only status, activity, partial logs, or the UI panel does not consume
  an answer. A cancelled query does not acknowledge delivery. Reading an old
  answer while a reply is running never consumes the reply's later answer.

This is boundary delivery, not an interruption of tokens already being streamed.
An answer arriving during the parent's final response can still require a later
model response; the plugin cannot retroactively change text already shown. If a
required result is still outstanding, use `wait` before claiming completion.
Once a notification is submitted to Pi, it cannot be withdrawn; proactive
inspection suppresses notifications that are still pending in the plugin.

`reply` sends a follow-up message to a live background child (they run on
pi's RPC transport, so the process survives its own turn). On an **idle**
lane — turn settled, child alive — it starts a new turn. Mid-turn,
`interrupt: true` steers (injected after the current tool calls), while the
default queues a `follow_up` for after the turn. A turn's answer is
available when the child turn actually settles (`agent_settled`), not when the
process exits: the lane then reads as answered-awaiting-reply, and `show`
and `wait` already carry its text. Automatic delivery follows the parent's
boundaries described above. An idle lane settles on its own after a
keep-alive window (5 minutes, `PI_SUBAGENT_KEEPALIVE_MS`) — the window only
keeps the process warm for replies; ending it does not re-deliver an answer
already sent, and a failure mid-turn still reports. Idle lanes hold no
capacity slot, so a parked lane never blocks a launch. A reply that starts
a new turn must reclaim a slot first; at the concurrency cap it is refused
without sending the prompt or changing the idle lane. Retry once a busy lane
settles or goes idle. Mid-turn steer and follow-up commands use the lane's
existing slot.

Extension dialogs inside an RPC child are answered rather than left hanging. An
RPC child is handed a real UI context, so `select`/`confirm`/`input`/`editor`/
`custom` emit a request and wait for a client response — and the child has no
client. Each is answered as cancelled, which is exactly what the no-op UI
context a JSON child already gets would have done; without it, one dialog from
any loaded extension would pin the child until its wall clock.

Three built-in agents ship in `src/catalog.ts` — `explore` and `review` are
read-only (`review` can also run commands), and `general` is the only
built-in that can modify files. Descriptive names like `general-purpose`
resolve to `general`. User `.md` files with a matching name replace a
built-in. The `agent` argument accepts an optional `alias` for the display
name shown in the fleet widget and panel.

At most four subagents run at once (`PI_SUBAGENT_MAX_CONCURRENCY`, a positive
integer, overrides it). The cap counts *busy* lanes of both kinds — pi runs a
tool batch in parallel, so foreground calls share it too: a blocking call past
the cap waits for a slot instead of being refused, and an idle lane parked
awaiting a `reply` holds none. A background launch at the cap is still
refused. Handles and results remain
in memory for the current session; the most recent 20 settled tasks are kept.
Switching sessions, navigating the history tree, forking, or shutting down
cancels active tasks and suppresses their late results. Completed tasks wake
the parent agent; failures and cancellations appear in the transcript without
starting another turn.

`show` reports the current phase and time since the last child event; after 90
seconds without an event it marks the task as a possible stall. This is a
liveness hint, not proof that the child is stuck: a provider may take a long time
to answer without emitting an event. `events` returns up to ten recent
lifecycle events.

The bound that *acts* is a separate silence cap. A child that emits nothing for
five minutes is failed with the last event named —
`no output for 300000ms (last event: tool_start find)` — instead of silently
spending the rest of its fifteen-minute budget. Set `PI_AGENT_STALL_MS` to
change it in milliseconds, or to `0` to turn it off. The cap applies to both
transports, and a background lane waiting between turns for a `reply` is exempt,
because that silence is expected.

A tool call that declared its own `timeout` outranks the cap for as long as it
runs: pi's shell tools take seconds, and a command that named its own budget has
already decided how long it may run. That is what keeps this bound from fighting
`pi-workflow`'s ten-minute shell budget (`PI_WORKFLOW_CHILD_BASH_TIMEOUT_MS`),
and it matters for the silent case — pi's shell tool only emits progress when the
command prints, so a quiet ten-minute build produces no events at all. A tool
that declared nothing (pi's `find`, `grep`) is still caught at five minutes.
When the declared budget is exhausted, the tool's own timeout reports it.

The activity trail is metadata-only. It can show event types, tool names, and
paths for `read`, `grep`, `find`, and `ls`; it does not retain prompts, search
patterns, tool arguments, or command output. The trail is bounded to ten events
per task.

For deeper debugging, explicitly request `action: "log"`. Background tasks
write the child's raw JSONL event stream to `~/.pi/agent/subagent-logs/` (or
`PI_SUBAGENT_LOG_DIR`). These logs can contain prompts, tool arguments and
outputs, so they are returned only by this explicit action. Without `query`,
the action reads the latest 2 MiB; with `query`, it searches the whole task log
(capped at 20 MiB). At most 50 matching lines and 32 KiB are returned per
call. Old logs are pruned after seven days or when the directory exceeds 200
files. Use `query` for a case-insensitive substring search and `lines` to bound
the number of returned matches.

In the TUI, the call shows the selected agent and task. While the child runs,
the result card shows its current tool, file path when available, and completed
tool count; expanding it shows the five most recent tool activities. Search
patterns, command contents and output are not copied into progress updates. When the child
finishes, the card shows its status and reply preview. The complete reply
remains in the tool result details.

## Watching the fleet

Background children also get a human-facing surface, because a card in
scrollback cannot describe work that is still in flight:

- **A widget under the editor** appears while at least one child runs — one
  stable row per child (icon, alias, task, elapsed, output tokens), folded past
  six rows — and disappears when the last child settles. Rows are deliberately
  stable: live tool calls and streamed text would churn every row on every
  child event. Foreground calls register as lanes too — a blocking call no
  longer looks like an idle session; they never occupy a background slot and
  cannot be cancelled by id.
- **`/subagents`** prints the same listing the model's `subagent_tasks`
  produces. **`/subagents live`** opens an overlay panel: `↑`/`↓` select
  (selection follows the record id, so a settling child does not move the
  cursor onto a different one), `enter` opens a detail view with the recent
  activity trail and result, `t` folds the child's event log into a readable
  transcript (assistant text, tool calls, bounded results — no persisted
  child session needed), `l` drops to a bounded raw-log tail, `k` cancels a
  running child, and `Esc` backs out one level at a time.
- **`n` / `/subagents notify`** toggles a user-facing completion notification:
  by default only the model is told a child finished; with it on, a toast
  announces each settle (`PI_SUBAGENT_NOTIFY_DONE=1` makes on the default).
- **`ctrl+shift+a`** opens the panel without typing. Extension shortcuts take
  precedence over user keybindings and conflict loudly in `/hotkeys` output;
  the widget's hint line always shows a working way in.
- **`PI_SUBAGENT_DOWN_INSPECT=1`** additionally opens the panel on `down` at an
  empty editor. It is opt-in: that key browses prompt history, and a TUI-level
  input listener runs before dialog focus, so it can swallow `down` aimed at an
  open selector.
The transcript is a fold of the child's own JSON-mode event stream, not a
resumed session: children still run `--no-session`, so the fold never appears
in `/resume` and cannot be resumed into a session that bypasses the one-level
fan-out guard.

- A child with no event for 90s is marked `stalled` (◉) in the widget and
  announces itself once per child via a warning notification — the same
  threshold `subagent_tasks` reports as "possible stall".

## Built-in agents

Three agents are available immediately after installation — `explore` (read,
grep, find, ls), `review` (the same plus `bash`), and `general` (the only one
that can modify files). With no model override, each child uses the parent
session's currently selected model. Use `explore` for a bounded investigation; a
direct `grep` or `read` is still cheaper for a simple lookup.

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
| `description` | one line shown when the model needs the list (required, unless the name matches a built-in) |
| `tools` | comma-separated or YAML list; omit to give pi's default set, or, when the name matches a built-in, to inherit that built-in's list |
| `model` | persistent override for this agent; omit to inherit the parent session's current model |
| body | the delegated system prompt |

### Overriding a built-in's model

A file whose `name` matches a built-in is a **partial** definition: whatever it
leaves out is inherited from that built-in. To pin a model per built-in, write
one three-line file per agent and nothing else:

```markdown
---
name: explore
model: provider/small-model
---
```

```markdown
---
name: review
model: provider/frontier
---
```

`explore.md` now uses `provider/small-model`, and still has the built-in's
description, prompt and read-only tool list. Fields fill in one at a time, so
the same file can also set just `description`, just `tools`, or a full
replacement — anything present wins, anything absent inherits.

Two rules are worth knowing, because they are the fail-closed half:

- **An omitted `tools` inherits the built-in's allowlist, never pi's default
  set.** `tools` omitted in a file that names its own agent still means "pi's
  default set"; for a built-in override it does not, or a model-only
  `explore.md` would silently hand a read-only agent write and shell access.
- **An explicit but unusable `tools` still skips the whole file** (`tools: []`,
  `tools: 3`), leaving the built-in untouched rather than half-applied.

One consequence of pinning a model: the parent's thinking level is inherited
only when *no* override applies, so an agent with its own `model` (file or call)
runs at that model's default effort instead of the session's level.

**Only user scope is read.** A project-local `.pi/agents/*.md` would be a
repository-controlled system prompt — installing a plugin is not consent to run
whatever a repository's author wrote — so this first cut does not load project
agents at all. Project scope can be added behind a trust check later.

Discovery runs on every call, so editing an agent file takes effect without a
restart. Inheritance always comes from the built-in, never from another user
file, so two files claiming one name cannot leak fields into each other. A file
naming a new agent must stand alone: it needs its own `description`, because
nothing else supplies one. An unknown agent name returns the available names
without launching a child.

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
is killed by a 15-minute wall-clock cap (`DEFAULT_AGENT_TIMEOUT_MS`) — per turn
on an RPC lane, so keep-alive idle time and earlier turns do not eat a reply
turn's budget; the keep-alive window is what bounds an idle lane.

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

## Task deadlines

The default **total task deadline is 1800 seconds (30 minutes)**, including model generation
and every tool call. It does not reset when progress arrives. This differs from
the five-minute silence bound and from an upstream request timeout. A tool's
declared timeout can extend the silence allowance, but cannot extend the total
task budget. Delegate focused review scopes; avoid running the same broad test
suite in several parallel reviewers.

Use `subagent(..., timeout: 10800)` for a three-hour task, or set
`PI_SUBAGENT_TIMEOUT_SECONDS=10800` in the parent Pi environment. Allowed values
are 1–10800 seconds (maximum three hours); an explicit call parameter takes
precedence. Both foreground and background children receive this budget.
Failures report the last observed activity; diagnostic log paths stay in tool
details and explicit `subagent_tasks log` output.

## Development

```sh
bun test
bun run typecheck
```

The child process is run by the workspace library [`pi-agent-runner`](../agent-runner)
(spawn rules, JSON event folding, timeout/abort kill, child environment), shared
with `pi-workflow`. See [ATTRIBUTION.md](ATTRIBUTION.md). A fix to the spawn path
belongs there, and both consumers get it.


## Paseo child pages

Paseo receives `outputFile` on a terminal `subagent-update`. The file is a
bounded pi-message JSONL snapshot containing the task, completed assistant
messages (including thinking and tool calls), tool results, and the final
answer or failure/cancellation reason. Both foreground and background calls
publish a transcript. This uses the existing Paseo adapter without modifying
Paseo or adding configuration.

Paseo 0.10.3 hydrates child sessions only when a turn settles, not while that
turn is streaming. Replies expose a new immutable file containing only the
new messages, so earlier answers remain visible without repeating history.
Each snapshot stays below Paseo's 2 MiB/200-item read limits; long content is
truncated and older entries may be omitted. Snapshot files share the raw log
folder's seven-day/200-file cleanup policy. Reload pi before launching new
children; existing historical blank pages do not gain transcripts retroactively.
