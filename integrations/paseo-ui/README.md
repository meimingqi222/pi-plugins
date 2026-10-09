# Pi plugins for Paseo

Optional client plugin for Paseo **0.11.0 or later**. It renders the status
messages from pi-subagent, pi-workflow, pi-bg-bash and pi-goal as compact, native-style tool rows,
including a live card for a running subagent call. Pi extensions continue to
work independently in Pi TUI. No Paseo source patch is needed. The companion
has a server RPC for bounded log reads and its own live output screen.

From the repository root, install development dependencies with `bun install`,
then register the directory using Paseo's CLI:

```powershell
paseo plugin install D:/code/pi-plugins/integrations/paseo-ui
paseo plugin ls
```

External plugins must be enabled in Paseo's plugin settings. Reload Pi after
updating its extensions. This repository does not automatically install or
enable the companion plugin or restart a running daemon.

Without the companion, status messages stay readable plain text. Disabling it
restores native timeline rendering. Original tool calls, answers and subagent
navigation are preserved. Failed or running `subagent_tasks` list/show/wait
results can also use cards, with short display IDs and diagnostic paths omitted.
Successful answers and reply/cancel/log output retain their native rendering.
Subagent running snapshots are hidden, including during history replay, so
each progress tick does not become another card. Terminal states remain in
the timeline; other work kinds continue to show their published states. A running subagent
call holds one live card in place of its tool row and returns to the native row
once the child settles, followed by its terminal status card.

Bash, Subagent, Workflow and Goal share the native tool-row density, icon size
and disclosure layout. Normal rows start collapsed with a single-line task or
command summary and a muted status. Click the row to expand the saved command,
task description, activity, task ID and metrics; PID stays in these details.
Failures start expanded, while manual disclosure choices survive status updates.
Shell uses the native terminal icon and other extension tools use its generic
Wrench icon. Running labels follow the native foreground/opacity treatment;
completed rows return to muted text instead of a green status badge.

Click the separate terminal button on a subagent row to open the plugin output screen.
Foreground progress and background launch cards expose this entry before the
child finishes. The screen refreshes every 750 ms, showing unfinished text,
thinking, tool arguments, incremental tool output and final results. Thinking
and completed tools use compact, expandable rows matching the main conversation;
Shell rows show command summaries. The transcript uses the native default
820 px centered content column, compact row padding and 12 px tool icons
(Read uses Eye; Write/Edit use Pencil). Running and failed tools open their details
by default, and an explicit expand/collapse choice survives refreshes. The
0.11 SDK does not export the native timeline renderer, so these rows use the
host colors and icon API rather than importing private app components.
The SDK exposes colors only, so custom host font-size/content-width preferences
are not yet available to this companion; layout uses the native defaults. Disable
Follow output to inspect earlier text; refresh retries a disconnected read.
Leaving the screen stops polling. This is the companion screen, not Paseo's
native child page; the latter retains its host-version limitations.

Update both pi-subagent and this companion, then reload Pi and run
`paseo plugin reload pi-plugins-work-status`. Existing historical cards without
a transcript reference remain readable but have no new output entry.
Custom `PI_SUBAGENT_LOG_DIR` or `PI_CODING_AGENT_DIR` settings must match in
the parent Pi process and the Paseo daemon environment. Logs remain local to
the daemon. The RPC accepts only raw subagent evidence filenames in that
directory, rejects symlinks and scans at most 2 MiB. The screen shows at most
120 recent blocks / 256 Ki characters, explicitly marking omitted history.

Historical subagent cards show the task's latest execution state, activity and
tool count while preserving the original title and task description. The
companion shares one timeline subscription per parent conversation and restores
status from Paseo's saved canonical timeline when reopening a conversation;
the completion card need not be visible and the raw log need not still exist.
A later reply can move the same task back to Running. Leaving the conversation
releases the observation. The underlying history messages remain unchanged.

## Delivery and version limits

By default, RPC status uses passive Pi custom messages. It does not trigger a
model turn. Pi defers these messages while the parent is executing, until a
safe turn boundary. Foreground subagent tool progress uses `onUpdate` and can
stream during the call. The companion renders that partial result as a live
card, so a blocking subagent call shows its activity, completed tools and
status while the child works. Background lanes publish through passive
messages, so their cards appear at the next boundary.

Cards cover the default `message` transport only. The app restricts timeline
transformers to a closed set of agent item types that excludes `notification`,
so status sent as a notification stays a native notification row. The same five
lines remain readable there. Set `PI_RPC_PROGRESS_TRANSPORT=notify` in the
**parent Pi process environment** to deliver background state immediately
through that transport instead of at a turn boundary; it applies to all four
stateful plugins. States are deduplicated and coalesced at a two-second cadence,
terminal states bypass the delay, and session changes discard queued updates.

On hosts with Pi child-file following, RPC background launches expose an
append-only transcript immediately. Their child pages receive completed model
messages, tool calls and tool results during execution. Follow-up turns attach
a fresh file through the host's existing runtime notification. Foreground
calls show their current activity in the parent's live card; the native child
page still loads after the blocking tool returns because the host does not
register foreground transcript files from partial results.

The companion does not add live subagent child-page support to an older Paseo
version. Paseo 0.10.3 installations keep their existing terminal
transcript behavior and readable status messages; install the UI companion only
after upgrading to a version with timeline transformer support.

## Development

```powershell
bun run --filter pi-plugins-paseo-ui typecheck
bun run --filter pi-plugins-paseo-ui test
```

The client recognizes bounded five-line work-status messages, with an optional
sixth transcript-reference line for subagents, and background launch results. It leaves
ordinary assistant text and incomplete streaming content untouched. Its
renderer uses the host's theme and React Native components on desktop and mobile.

Set `PI_RPC_CLIENT=paseo` in the parent Pi process environment to opt into
Paseo's live-child transcript notifications. Other RPC clients receive the
standard subagent updates without Paseo-specific notification text.
