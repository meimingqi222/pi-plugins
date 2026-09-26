# pi-subagent refactor plan: contract, lane model, live-child continuation

**Status:** approved for execution
**Scope:** `plugins/subagent`, `plugins/agent-runner`, `plugins/run-core`
**References:** `2026-09-27-subagent-fleet-surfaces-design.md`, `2026-09-27-shared-background-work-surface.md`, `2026-09-27-subagent-transcript-and-notify.md` (all under `.agents/notes/`)

## Goal command (run this to execute)

```
/goal Refactor pi-subagent per plugins/subagent/docs/refactor-plan.md. Execute P0, P1, P2 in order, one commit per phase. Every phase must end with bun run typecheck + bun run test + bun run notes green in the repo root. Ship one regression note per non-trivial change under .agents/notes/implemented/feature/. Do not skip a phase or merge two into one commit. --tokens 800000
```

`/goal` takes a trailing `--tokens N` budget; the objective is everything
before it.

## First-principles frame

A subagent is **a bounded lease on a context window**. It decomposes into five
irreducible layers, and every feature belongs to exactly one:

| Layer | The question it answers | Current state |
|---|---|---|
| **Catalog** | Who can do the work (tools, persona, name resolution, trust) | 1 builtin, user files, no alias, no precedence beyond "file wins" |
| **Contract** | What goes in, what comes out, what control channel exists | `task` + `agent` + `model` + `background`; result + cancel; no write-spec, no ownership rule, no anti-poll statement |
| **Lifecycle** | How it lives and can be intervened with | spawn → run → settle/cancel/timeout; **no reply, no steer, no wait, no in-flight id** |
| **Observability** | How each side sees it | Model side and user side are the strongest layer already |
| **Bounds** | What prevents runaway | env fan-out guard, 4-way concurrency, 15-min timeout; **no file-ownership rule** |

Gaps against both reference implementations: lifecycle (reply/steer/wait) and
contract text (delegation write-spec, file-ownership, anti-poll). Our
observability layer already exceeds both.

## Target architecture

```
pi-subagent
├── catalog.ts          NEW  builtins + aliases + precedence (replaces BUILTIN_EXPLORE inline)
├── agents.ts                  file loading only (frontmatter parse, discoverAgents)
├── contract.ts         NEW  SUBAGENT_DESCRIPTION/GUIDELINES + param descriptions, dynamic agent catalog text
├── lane.ts             NEW  Lane = { id, alias, kind: fg|bg, state, queuedPrompts, generation, record }
├── background.ts              BackgroundRegistry → LaneRegistry (storage + settle fan-out)
├── transport.ts        NEW  spawn-mode abstraction: json-run (P0-P1) vs rpc-child (P2)
├── tool.ts                    executeSubagent + SUBAGENT_TASKS actions (add wait, reply)
├── fleet.ts                   WorkItem mapping + panel-row + detail renderers (unchanged shape)
├── widget.ts                  FleetReporter (unchanged)
├── panel.ts                   PanelComponent (unchanged shape; reads lane.state)
├── transcript.ts              fold + render (unchanged)
└── index.ts                   wiring only

agent-runner
└── rpc-child.ts        NEW  RPC transport: spawn --mode rpc --no-session, stdin prompt/steer/abort,
                             JSONL event stream consumed identically to executor.ts
```

`Lane.state`: `queued | running | idle-awaiting | stalled | completed | failed | aborted`
(`idle-awaiting` exists only under RPC transport: turn ended, child alive,
queued prompts may arrive; it is where `reply(interrupt:false)` lands).

## P0 — contract & catalog (no runtime behaviour change)

### Files
- `src/catalog.ts` (new): `BUILTIN_AGENTS` (3 entries), `AGENT_ALIASES`,
  `resolveAgent(name, definitions)`, `formatAgentGuidance(definitions)`
- `src/agents.ts`: move `BUILTIN_EXPLORE` out into `catalog.ts`; keep file
  loading/discovery only
- `src/contract.ts` (new): exports `SUBAGENT_DESCRIPTION`,
  `SUBAGENT_GUIDELINES`, and param-description constants consumed by `tool.ts`
- `src/tool.ts`: descriptions come from `contract.ts`; `subagent_tasks` params
  gain `action: "wait"`

### Changes

**Built-ins** (default read, write is explicit — the Step-Code/minimax
consensus):

| name | tools | one-line prompt |
|---|---|---|
| `explore` | `read,grep,find,ls` | (existing, move to catalog) |
| `review` | `read,grep,find,ls,bash` | "Review the requested change. Do not edit files; report concrete findings with file references." |
| `general` | `undefined` (all) | "Work independently on the delegated task and return a concise, verifiable result." |

**Alias:** `general-purpose`, `general purpose`, `general_purpose` → `general`.

**`SUBAGENT_DESCRIPTION` rewritten to include:**
- dynamic built-in list via `formatAgentGuidance()` (not a hardcoded line)
- "Parallel background children must own disjoint files; otherwise serialize."
- "Completion arrives automatically; do not poll `subagent_tasks` in a loop —
  use `wait` when you need to block on it."
- keep the existing anti-patterns ("not for a lookup a grep/read answers",
  "not for hand-chained fan-out — `pi-workflow`")

**`task` parameter description becomes the delegation write-spec**
(minimax's `LOCAL_TASK` shape, shrunk): `"Self-contained task. Include the
goal, the relevant paths, the ruled-out approaches, the file/directory
ownership boundary, the deliverable and its acceptance criteria, and the
answer format and length you want."`

**`subagent_tasks` new action `wait`:** `{ action:"wait", id, timeout?: seconds
≤30 }` blocks until the record settles or the deadline hits; returns the
record either way. Uses the same settle-notification path as `bg_tasks wait`
(the registry already notifies listeners on settle — subscribe, do not poll).

**`alias` parameter on `subagent`:** optional human name for the lane
(defaults to a task-derived slug); surfaces in widget rows and `/subagents`.

### Verification
`bun run typecheck`, `bun test plugins/subagent`, and a new
`test/catalog.test.ts` + `test/contract.test.ts` (alias resolution, unknown
name error includes the catalog text, description contains the ownership and
anti-poll sentences). Red-run: revert `AGENT_ALIASES` → alias test fails.

## P1 — lane model (renames + registration, no behaviour change)

### Files
- `src/lane.ts` (new): `Lane` type + `LaneRegistry` (rename of
  `BackgroundRegistry` + `kind`, `alias`, `queuedPrompts`, `generation`)
- `src/background.ts`: re-export `Lane`/`LaneRegistry` for compatibility;
  `deriveChildState` unchanged
- `src/index.ts`, `src/fleet.ts`, `src/panel.ts`, `src/widget.ts`,
  `src/tool.ts`: consume `Lane` instead of `BackgroundRecord`

### Changes
- `BackgroundRegistry` → `LaneRegistry`; `BackgroundRecord` → `Lane` with
  `kind: "background" | "foreground"`, `alias`, `queuedPrompts: string[]`,
  `generation: number`.
- **Foreground calls join the registry** as `kind: "foreground"` lanes. They
  do not consume a background concurrency slot and are not killable through
  `subagent_tasks` (they have no id yet — they live only for the call's
  duration). Widget/panel show them so a foreground call is observable;
  `stop`/`cancel`/`reply` return "not addressable" for them.
- `alias` is the human-facing name in widget rows (falls back to a
  task-derived slug); `id` remains the dispatch identity.
- `queuedPrompts` and `generation` are storage only in P1 — they are the
  fields P2's `reply` needs, introduced now so the P2 diff is transport-only.

### Verification
`bun run typecheck`, `bun test plugins/subagent` (all existing tests must
pass unchanged — P1 is a rename, not a behaviour change), and a new
`test/lane.test.ts` (foreground lanes appear in `list()` but never occupy a
background slot; `stop` on a foreground lane returns false). Red-run:
revert foreground registration → foreground-in-list test fails.

## P2 — RPC transport + live-child reply (the only transport change)

### Files
- `plugins/agent-runner/src/rpc-child.ts` (new): spawn `pi --mode rpc
  --no-session`, write stdin commands, fold the stdout JSONL event stream the
  same way `executor.ts` does (the event shapes are identical; the only new
  event is `response` for stdin command acks, which is consumed and dropped)
- `plugins/agent-runner/src/index.ts`: export the RPC transport
- `src/transport.ts` (new): `ChildTransport` interface with two
  implementations — `JsonRunTransport` (existing pipe, kept as the
  foreground path and as the non-RPC fallback) and `RpcChildTransport`
  (background path, keeps the child alive for follow-ups)
- `src/tool.ts`: `subagent_tasks` gains `action: "reply"`

### Changes
- **Background children spawn `--mode rpc --no-session`** instead of
  `--mode json -p`. Foreground calls keep `--mode json -p` — a foreground
  call is one-shot by definition and the simpler transport is correct there.
- RPC child lifecycle: `prompt` launches the turn; `agent_end` transitions
  the lane to `idle-awaiting` (turn done, process alive); a queued prompt or
  the settle timeout ends it. `stop` sends `abort` then falls back to the
  existing process-group kill.
- **`subagent_tasks` `reply`:** `{ action:"reply", id, prompt,
  interrupt?: boolean }`. `interrupt: false` writes
  `{"type":"followUp","message":prompt}` (delivered after the current turn);
  `interrupt: true` writes `{"type":"steer","message":prompt}` (injected
  after the current tool calls, before the next model call). Replies on a
  settled or non-RPC lane return "lane is not live". Replies on a lane that
  is `idle-awaiting` take effect immediately.
- Lane gains a **keepAlive window** (default 5 min, `PI_SUBAGENT_KEEPALIVE`
  env): after `idle-awaiting` with no queued prompt, the lane settles with
  its last assistant text as the answer — same deliver path as today, so a
  fire-and-forget caller is never held open by an idle lane.
- `SCHEDULER_DISABLE_FLAGS` still land in the child's env; an RPC child is
  one level, exactly like a JSON-run child.

### Verification
`bun run typecheck`, `bun test plugins/subagent plugins/agent-runner`, and:
- `test/rpc-child.test.ts` (spawn argv, stdin command shapes, event fold)
- `test/lane-reply.test.ts` (reply on `idle-awaiting` writes `followUp`,
  `interrupt:true` writes `steer`, reply on settled lane returns the error,
  keepAlive settles the lane on the deadline)
- `test/transport.test.ts` (foreground calls still use JSON-run)

Red-run: revert the `reply` handler to a no-op → `lane-reply` tests fail.

## Rejected (priced and recorded)

- **Persisted child sessions (`--session`)**: `/resume` pollution + the
  `PI_SUBAGENT_DISABLE` env does not travel with a session file, so a resumed
  child bypasses the one-level fan-out contract. `keepAlive` covers the
  "one more question" case without it.
- **`tasks[]`/`chain[]` in this tool**: composition is `pi-workflow`'s job;
  the unary contract is the correct primitive.
- **Model-side progress notifications**: pull (`subagent_tasks events`) is
  already sufficient; a mid-turn steer is net-negative.
- **`agent:` URI disambiguation**: we have filesystem definitions, not
  runtime agent entities; file precedence is enough.
- **System-prompt delegation guidance**: neither reference does it; the tool
  description is the right prompt surface.
- **tmux/herdr transport**: Windows and headless do not support it; RPC is
  the same-layer, strictly-more-capable answer.

## Definition of done

- All gates green: `bun run typecheck`, `bun run test`, `bun run notes`, `bun run secrets`.
- One regression note per phase under `.agents/notes/implemented/feature/`.
- README updated per phase (P0 contract section, P1 lane section, P2 reply/keepAlive section).
- No behaviour change ships without a test that failed red first.
