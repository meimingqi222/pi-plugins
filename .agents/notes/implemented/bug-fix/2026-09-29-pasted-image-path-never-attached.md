# Agent Note: A pasted image becomes image content, not a path

Status: implemented

## Problem

pi accepts an image in exactly four places, and none of them is "the text the
user submitted": the `read` tool, CLI `@file` arguments, `session.prompt()`'s
`images` option (RPC, SDK, extensions), and tool-result images. The editor is
not one of them.

Pasting an image does not create an attachment. In `@earendil-works/pi-coding-agent`
0.87.1, `dist/modes/interactive/interactive-mode.js:2413-2432` reads the
clipboard into `<tmpdir>/pi-clipboard-<uuid>.png` and inserts **that path as
text**; the submit path then calls `session.prompt(text)` with no images
(`interactive-mode.js:2624-2638`). A terminal drag-and-drop puts a path in the
editor the same way. Confirmed against this machine's own sessions: every user
message carrying a `pi-clipboard-*.png` path is plain text with no image block,
no user message ever contained both, and the bytes only entered the transcript
after the model decided to call `read`.

Two failures follow, and the second one is why this is a bug rather than a UX
nit:

1. The model has to decide, unprompted, to `read` the path. When it does not,
   the screenshot is silently absent from the answer (upstream issue #2144 is
   this exact complaint, resolved by asking every user to add a prompt
   instruction).
2. Until it does, the request carries a path where the user meant an image.
   Measured against the CodeBuddy upstream used from this machine: `file://…`,
   a bare absolute path and a bare filename each returned
   `400 11133 Invalid request parameters` (941-byte body); `https://…` returned
   `400 11135 Please start a new conversation, replace the image…` (962 bytes);
   only `data:image/png;base64,…` returned 200. The proxy in front of that
   upstream forwards an image field verbatim (`normalizeCompatImageUrls` in
   `copilot-api` converts the *shape* of `image_url` and documents that it
   "不校验内容"), so one reference-shaped value ends the whole conversation.

## Decision

`plugins/paste-image` registers an `input` handler that rewrites references into
attachments before the prompt leaves pi:

- `src/references.ts` finds references without touching the filesystem:
  absolute and relative paths, `~/`, `file://` URLs (percent-decoded), pi's
  `@path` form, quoted (`"My Shot.png"`) and shell-escaped (`My\ Shot.png`)
  spaces. Surrounding punctuation — `(/tmp/a.png).`, a trailing comma — is
  stripped, but only *unmatched* brackets, so a filename that contains one
  survives.
- `src/attach.ts` resolves each reference (absolute, then cwd, then the temp
  directory for a bare name), asks an injected `load` for bytes, numbers
  distinct images in first-reference order, and rewrites the text.
- `src/index.ts` supplies the real `load`: `stat` for existence and size, then
  pi's own `detectSupportedImageMimeTypeFromFile` for acceptance — the same
  oracle the `read` tool uses, including its rejection of animated PNGs — then
  base64. Files over 32 MiB are skipped.
- Attach only when `ctx.model.input` includes `"image"`. With a text-only model
  the path is left alone: a path is still actionable through `read`, `bash` and
  OCR, and `pi-ai` would otherwise downgrade the attachment to an
  `(image omitted: model does not support images)` placeholder.
- Nothing is attached speculatively: text with no resolvable reference comes
  back byte-identical, and the handler returns `action: "continue"` if anything
  throws.

## Alternatives considered

**Wait for pi to do it.** Upstream declined: in issue #3318 the maintainer
answered both proposed options (an `@` prefix, and converting the clipboard to
`ImageContent`) with "currently not planning on implementing this, as it has
more implications". A fix pinned on that decision leaves the failure in place.

**Attach the bytes but keep the path in the text.** Cheaper to implement and it
fixes failure 1, but it keeps a path-shaped string in the payload — the exact
thing the reference-rejecting upstream refuses — and it invites the model to
`read` the same image a second time.

**Fix it in the proxy instead.** Inlining `file://` and bare-path references in
the request normaliser fixes every client, not just pi, and remains the right
backstop. It is also in a different repository, and it only helps once the
reference has already travelled through a client that chose to keep it; doing it
here means the reference never leaves pi at all.

**Use an existing third-party extension** (`pi-paster`, `pi-image-paste`,
`pi-image-tools`). They solve the same problem, but this repository pins
behaviour with its own tests and notes, and the model-capability guard — leaving
the path untouched for a model that cannot see images — is a decision this
plugin makes explicitly.

## Consequences

- A pasted screenshot now costs its base64 in the turn that uses it. Before, it
  cost a path plus a `read` round trip that copied the same bytes into a tool
  result, so the common case is strictly cheaper in round trips.
- A path named in prose is now an attachment, and its text becomes `[#image N]`.
  Paths inside fenced code blocks and inline code spans are excluded to keep
  quotes and snippets intact, and a path that does not exist, is not an image,
  or is too large is left alone — but a bare path in prose is otherwise
  indistinguishable from a pasted one, and it will be replaced.
- A path with an unescaped space is not guessed at: `Shot (1).png` splits, and
  the `(1).png` fragment is rejected rather than resolved as if it were a bare
  filename, which could otherwise attach a wrong file from the cwd. Terminals
  escape or quote the paths they insert, so drag-and-drop is unaffected.
- If pi's resizer rejects an attached image downstream (an extreme aspect or a
  file that cannot be brought under the model's byte limit), the reference has
  already been replaced and the turn carries an `[Image omitted…]` hint instead.
  The user's text no longer names a path in that case; the alternative is
  keeping the path and hoping the model reads it.
- The decision is per prompt: the model capability check is the only dynamic
  input, so a `/model` switch changes behaviour on the next message.

## Verification

- `plugins/paste-image/test/references.test.ts` — finding a pasted clipboard
  path in prose; punctuation wrapping; file-URL percent-decoding and a localhost
  authority; `@path`; ignoring non-image and `.png.bak` names; ignoring fenced
  and inline code; a fence not swallowing the text after it; several references
  in order; the unescaped-space case; whole-token rewriting including quotes.
- `plugins/paste-image/test/attach.test.ts` — `candidatePaths` order; a
  clipboard path attached with `[#image 1]`; a bare name tried in the cwd first
  and then the temp directory; distinct images numbered in first-reference order
  with a repeat reusing its number; text left byte-identical when nothing
  resolves, when the file vanished, and when the loader throws.
- `plugins/paste-image/test/plugin.test.ts` — `transformInput` with a real PNG
  through pi's own sniffer; a `.png` name over non-image bytes; a text file; a
  missing path; a text-only model keeping the path; pre-existing images
  preserved; `pasteImageExtension` registering the `input` hook and transforming
  through it.
- `plugins/paste-image/test/loader.test.ts` — the published entry point loaded by
  pi's own `DefaultResourceLoader` with no errors, so a broken factory or an
  unknown event name fails here instead of loading as a dead extension. Not part
  of the red run: disabling the transform leaves loading unaffected.

Proved: replaced the attachment branch in `transformInput` with an
unconditional `{ action: "continue" }` — today's pi behaviour, where the path
stays text and nothing is attached — and ran `bun test`: `3 tests failed`,
`26 pass`. "a real image path becomes image content plus a placeholder" received
`"continue"` where it expected `"transform"`, alongside "images a caller already
attached are preserved" and "wires the input hook and transforms through it".
Restoring the branch returned `29 pass`, and `tsc --noEmit` is clean.
