# Pi plugins for Paseo

Optional client plugin for Paseo **0.11.0 or later**. It renders the status
messages from pi-subagent, pi-workflow, pi-bg-bash and pi-goal as native cards.
Pi extensions continue to work independently in Pi TUI. No Paseo source patch,
server entry, polling process or private runtime bridge is needed.

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
Cards show each published state in the timeline;
they do not merge older events into a single task dashboard.

## Delivery and version limits

By default, RPC status uses passive Pi custom messages. It does not trigger a
model turn. Pi defers these messages while the parent is executing, until a
safe turn boundary. Foreground subagent tool progress uses `onUpdate` and can
stream during the call.

For Paseo versions that display RPC `notify` events, set
`PI_RPC_PROGRESS_TRANSPORT=notify` in the **parent Pi process environment** to
receive background state immediately. This applies to all four stateful
plugins. Keep the default `message` transport on older hosts. States are
deduplicated and coalesced at a two-second cadence; terminal states bypass the
delay. Session changes discard queued updates.

The companion does not add live subagent child-page support to an older Paseo
version. Paseo 0.10.3 installations keep their existing terminal
transcript behavior and readable status messages; install the UI companion only
after upgrading to a version with timeline transformer support.

## Development

```powershell
bun run --filter pi-plugins-paseo-ui typecheck
bun run --filter pi-plugins-paseo-ui test
```

The client only recognizes bounded five-line work-status messages. It leaves
ordinary assistant text and incomplete streaming content untouched. Its
renderer uses the host's theme and React Native components on desktop and mobile.
