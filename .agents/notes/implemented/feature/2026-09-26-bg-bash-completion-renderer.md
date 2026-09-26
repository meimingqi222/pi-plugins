# Agent Note: Draw background completions for a person without changing what the model reads

Status: implemented
Partly-superseded-by: 2026-09-26-bg-bash-late-completion-routing.md

## Problem

A finished background job reports back as a `custom` message with
`display: true` and no renderer, so pi draws it with the default
custom-message view: the raw content through the markdown renderer, inside a
box labelled `[bg_bash_result]`. That content is a flat report — a status
sentence, a `Command:` line, the truncated output, and an inline
`[Showing lines … Full output: …]` footer. It is written for a model to read,
and it reads badly for a person:

- **Markdown reinterprets the output.** A `#` comment in a build log becomes a
  heading, `---` becomes a rule, tables and indentation reflow, and inline
  backticks become code spans.
- **Nothing bounds the preview.** Up to 2000 lines / 50KB land in the
  transcript, and the message is the newest thing on screen.
- **The facts are buried.** The status is inside a sentence
  (`Background bash job bg001 finished after 12.4s (exit code 0).`), the command
  wears a `Command:` label instead of the `$ …` the shell tools use, and the
  truncation footer is indistinguishable from another line of output.

The model reads this content as a user message, so the content itself cannot
change to fix any of it.

## Decision

Register a `MessageRenderer` for `bg_bash_result` that draws the message for a
person and leaves the content untouched:

- A status line — `<status> · <jobId> · <duration> · exit <code>` — colored
  `success`/`error`/`warning` by terminal status.
- `$ <command>` in `bashMode`, matching the built-in shell renderer.
- The output in `toolOutput`, bounded to the last 20 lines when collapsed
  (width-aware, cached per width), whole when expanded.
- The truncation footer stripped from the body and drawn once as a warning, so
  the log pointer is a pointer rather than an output line.
- The whole thing inside the standard `customMessageBg` box, so it still reads
  as an injected message.

`details` already carries status, job id, duration, exit code, command, log
path, and the truncation result, so no new persisted state is needed. The output
tail — the one thing `details` does not carry — is recovered from the content by
exact prefix match against what `formatCompletionMessage` wrote. The truncation
footer now has a single builder (`truncationNotice`) used by both the model
string and the renderer, so the two cannot drift apart. Anything that does not
match — missing or foreign details, content this plugin did not write, a message
persisted by an older version — returns `undefined`, and pi falls back to its
default rendering instead of guessing.

## Alternatives considered

**Make the content prettier.** The content is exactly what the model reads;
prettifying it changes what the model reads, which is the property that had to
be preserved.

**Carry the output in `details` so the renderer can lay it out structurally.**
`details` is persisted with the message, so a 2000-line tail would be stored
twice in the session file. An exact prefix match costs one string comparison and
no session bytes.

**Read the log file during render to show more than the model saw.** A renderer
runs on every keystroke and must stay cheap and side-effect free. The warning
already names the path, and `bg_tasks log <id>` is the documented reader.

**Keep the markdown renderer and only bound the preview.** Bounding helps, but
the mangling is the other half of the complaint: a build log is not markdown,
and rendering it as markdown is what turns `#` and `---` into structure.

**Preview the head instead of the tail.** Bash output ends with the failure;
pi's own bash view keeps the tail, and the expand hint covers the rest.

## Consequences

- The model-facing content is byte-identical, and a test asserts the exact
  string rather than a substring.
- The expanded view shows the same retained tail the model read, not the whole
  log file.
- `@earendil-works/pi-tui` is a devDependency (types and component classes for
  tests); the host pi process provides the runtime copy, as it does for
  `pi-workflow`.
- The `[bg_bash_result]` label is gone from the transcript; the status line
  identifies the message.
- A renderer that throws is caught by pi and falls back to the default view, so
  a display bug cannot hide a result.

## Superseded

This message renderer still handles `bg_bash_result` messages saved by older
sessions. New completions use a TUI-only status entry and at most a short,
hidden model notification; they no longer include stdout in a visible custom
message. The original renderer unit tests remain relevant for old sessions.

## Verification

- `plugins/bg-bash/test/render.test.ts` — the model string is byte-identical,
  the collapsed view is bounded and reshaped, the log pointer appears once,
  every terminal status reads as a word, unusable details fall back
- `plugins/bg-bash/test/plugin.test.ts::the terminal record renders as one status line without injecting stdout`

Proved: with the `pi.registerMessageRenderer` call removed from the plugin
entry, that plugin test failed with `expect(received).toBeDefined()` /
`Received: undefined`. With the preview bound replaced by the full line count,
`render.test.ts` failed `expect(collapsed).not.toContain("line-01")` and
`expect(view).not.toContain("line-0101")`. Both pass once the registration and
the bound are restored.
