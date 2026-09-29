# pi-paste-image

Paste or drag an image into pi and it arrives as image content, not as a file
path the model has to go read.

Requires pi **0.85.1 or newer**. From this workspace:

```sh
pi install -l ./plugins/paste-image
```

## What it does

On every user prompt, `pi-paste-image` looks for image references in the text,
reads them, attaches them to the same turn, and replaces the reference with a
numbered placeholder:

```
/var/folders/tl/…/T/pi-clipboard-ca49e04e.png 这个 auto 是什么？
```

becomes

```
[#image 1] 这个 auto 是什么？
```

with the PNG attached as `ImageContent`. Recognised references:

| Form | Example |
| --- | --- |
| absolute path | `/Users/me/Shot.png` |
| `file://` URL | `file:///Users/me/My%20Shot.png` |
| home-relative | `~/Pictures/Shot.png` |
| relative to the cwd | `img/logo.webp` |
| bare clipboard name | `pi-clipboard-ca49e04e.png` (also tried in the temp dir) |
| pi's file-mention syntax | `@img/logo.png` |
| quoted or shell-escaped spaces | `"My Shot.png"`, `My\ Shot.png` |
| Windows path, separators and all | `C:\Users\me\Shot.png`, `\\server\share\Shot.png` |

## Why

pi's clipboard paste writes the clipboard to `<tmpdir>/pi-clipboard-<uuid>.png`
and inserts **that path as text**; a terminal drag-and-drop inserts a path too.
Nothing on the submit path turns it into an image, so the model has to decide,
unprompted, to call `read` on it — and until it does, the request that reaches
the provider contains a path where the user meant a picture.

That is usually just a wasted round trip. It is worse against an upstream that
does not accept image *references*: `file://`, a bare path or a bare filename is
rejected with a business error, a remote URL gets a different one, and only an
inline `data:` image is accepted. When one such request fails, the failure is
conversation-wide, not limited to the image. Attaching the bytes and removing
the path from the text means no reference ever leaves the machine.

## Behaviour worth knowing

- **Only when the model accepts images.** With a text-only model the path is
  left exactly as it was, because a path is still actionable (`read`, `bash`,
  OCR) while an image the model cannot see is not.
- **pi's own sniffer decides.** A candidate is attached only if
  `detectSupportedImageMimeTypeFromFile` agrees it is an image, so a `.png` name
  over other bytes, a text file, an animated PNG or a missing file changes
  nothing.
- **Text with no resolvable reference is byte-identical.** Nothing is rewritten
  speculatively.
- **Code fences and inline code spans are skipped**, so quoting a README line
  such as `` `![logo](./logo.png)` `` does not turn into an attachment.
- **A path with an unescaped space is not guessed at.** `Shot (1).png` splits on
  the space and the `(1).png` fragment is discarded; terminals escape or quote
  those paths, and hand-typed spaces can be quoted (`"Shot (1).png"`).
- **Only a space or a quote is escaped.** Everywhere else a backslash is a path
  character, not an escape, because that is what it is in a Windows path
  (`C:\Users\me\Shot.png`) and in a `\\server\share` prefix. The cost is that a
  POSIX path written with a literal backslash (`a\\b.png`) keeps both characters.
- **Large sources are skipped** (over 32 MiB) and pi's own `inputLimits.images`
  resize profile still applies downstream, so request size stays where pi's
  limits put it.
- **The same file twice is attached once** and both references get the same
  placeholder number.
