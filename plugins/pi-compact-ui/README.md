# pi-compact-ui

Make the pi conversation read as a list instead of a stack of boxes: one line
per tool call, thinking collapsed to a label, a calmer spinner, and a status line
that says what it means.

Install it like any other plugin in this workspace:

```bash
pi install -l ./plugins/pi-compact-ui
```

Nothing here touches colour. That is `pi-theme-mytheme`'s job, and mixing the two
would make neither retunable on its own.

## What it does

**Thinking collapses to one line.** Pi already supports this — `hideThinkingBlock`
renders a collapsed block as a single italic line — but it is a *setting*, not an
API, so the plugin cannot switch it on for you. Add it to
`~/.pi/agent/settings.json`:

```json
{ "hideThinkingBlock": true }
```

The plugin sets the collapsed label to `Thought` and, when the setting is off,
says so once at session start rather than leaving you to wonder why nothing
changed.

**Tool calls become one row each.** `✓ bun run test · 3 output lines · 12s`, with
the tool's own summary and a line count instead of a padded colour block.

**The spinner calms down.** A four-frame quarter-circle sweep at 220 ms, in place
of the default 80 ms braille flicker — the most movement on a screen that is
otherwise still.

**The status line gains a git branch and extension statuses**, labelled, and
dropped from the right when the terminal is narrow.

## Config

The extension factory takes options, so a host can assemble its own:

```ts
compactUiExtension({
  thinkingLabel: "Thought",        // what a collapsed block says
  compactTools: true,              // one row per tool call
  statusLine: true,                // replace the footer
  workingFrames: ["◐", "◓", "◑", "◒"],
  workingIntervalMs: 220,
})
```

Each piece turns off independently, because they fail independently: the tool
rows need a pi API this workspace's typecheck cannot see, and the footer needs a
UI context that only exists inside a session.

## What it cannot do

Two limits are structural, not effort:

- **The thinking label is one global string.** Pi exposes
  `setHiddenThinkingLabel`, which replaces the text *every* collapsed block
  shows. There is no per-block label, so the duration each block spent — the
  `2.65s` / `6.8s` the reference UI shows — is not reachable. Neither is a
  renderer registration for assistant messages: `registerMessageRenderer`
  covers `custom` messages only, so the component that draws thinking cannot be
  replaced.
- **Thinking and tool rows stay two lists.** Thinking is rendered *inside* the
  assistant message component, which also cannot be replaced, so the two cannot
  share one connector tree the way the reference UI does. Each reads as a list;
  they are not one list.

Collapsing a tool row never costs the full view: when the row is expanded the
renderer hands back to pi's built-in renderer, which the resolver still holds.

## Files

| File | What it is |
|---|---|
| `src/index.ts` | the extension: pure helpers plus the registration |
| `test/index.test.ts` | the helpers, the defaults, and the calls against a recording fake |

## Tests

The row's content is pure, so it is tested directly: the summary a tool call
gets (a search tool's query, not the path it searches), the output-line count (a
trailing newline is not a line), and the duration format.

The registration is tested against a recording fake `ExtensionAPI`, which pins
the part worth pinning — that the label is set, that the resolver returns
`renderShell: "self"` for every tool and leaves a tool with no built-in renderer
alone, that a host with `hideThinkingBlock` off is told once and a host with it
on is not nagged, and that a host whose settings throw still starts.

It cannot test pi's rendering: there is no terminal here, and a fake component
tree would only prove the fake was called.

```bash
bun run --filter @meimingqi222/pi-compact-ui test
```
