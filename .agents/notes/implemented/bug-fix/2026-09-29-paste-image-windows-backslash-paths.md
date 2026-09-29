# Agent Note: A pasted Windows path keeps its backslashes

Status: implemented

## Problem

`pi-paste-image`'s reference scanner split submitted text into tokens and treated
every `\` inside a bare token as a shell escape, on the grounds that a terminal
drag-and-drop writes a path with a space in it as `My\ Shot.png`. On Windows that
same character is the path *separator*, and pi's own clipboard paste inserts
exactly that spelling, so the two collided:

```
in   C:\Users\me\AppData\Local\Temp\shot.png
out  C:UsersmeAppDataLocalTempshot.png
```

The mangled expression still passed the `.png` check — the extension survives —
so it became a candidate rather than being ignored. `candidatePaths` then resolved
`C:Usersme…` against the cwd, found nothing, and `transformInput` returned
`continue`. The plugin's entire purpose, attaching the image the user pasted,
failed silently on the platform where its clipboard path is spelled that way,
and the failure was invisible in the text: the submitted prompt still carried the
path, exactly as if the extension were not installed.

The suite could not see it either. `pi-paste-image` was written and verified on
macOS — its fixtures are `/var/folders/tmp`, `/Users/me`, `/work/project`, and
`attach.test.ts` compared those literals against `candidatePaths` output, which
`path.resolve`/`path.normalize` had already turned into `\var\folders\tmp\…`. Nine
of its thirty tests failed on Windows, three of them for the real reason above
(`transformInput`, `pasteImageExtension`, both real temp files) and six because
the fixtures assumed POSIX separators, where the two are indistinguishable.

## Decision

A backslash is an escape only where a shell needs one — before whitespace or a
quote. Everywhere else it is a path character, so `C:\Users\me\shot.png` and the
UNC prefix `\\server\share\shot.png` survive tokenizing intact:

```ts
function isEscape(next: string): boolean {
  return isWhitespace(next) || next === '"' || next === "'";
}
```

`My\ Shot.png` still resolves to `My Shot.png`, and a quoted path (`"C:\My Dir\x.png"`)
never reaches this decision, because quotes are their own span. With the expression
intact, `path.isAbsolute` sees a drive-qualified path and the target becomes the
only candidate, so the file is read and attached.

The fixtures stop assuming POSIX: `stubEnv` folds both the file map and the lookup
through `path.normalize`, and `attach.test.ts` states its candidates with the same
primitives the code uses (`path.join` for home and tmpdir, `path.resolve` for cwd).
On POSIX those collapse to the previous literals, so the file still reads as the
same three claims — one candidate, home-relative, cwd-then-tmpdir — instead of
also asserting how `path.normalize` works on one platform.

## Alternatives considered

**Escape only on the platforms that need it (`process.platform === "win32"` skips
the whole branch).** Rejected: the same submitted text would then scan differently
per platform, and a Windows terminal that escapes a space (`C:\My\ Shot.png`) would
be the case that breaks instead — the mirror image of this bug, on the platform it
was written for. The rule is about what the *text* means, not where it is read.

**Treat `\\` as an escaped backslash (a POSIX literal `\`).** Rejected: a UNC share
begins with `\\`, so this silently rewrites `\\server\share\shot.png` to
`\server\share\shot.png` — a rooted path on the current drive, i.e. a different
file. Two characters that mean "a network share" on the platform in question
outweigh an escape no POSIX user writes.

**Keep no escape processing at all.** Rejected: it trades this bug for the one the
escape exists for. A terminal drag-and-drop's `My\ Shot.png` is a single token only
because the escape is honoured; dropping it splits the path at the space and the
scanner correctly refuses to guess at half a filename.

**Fix only the six platform-shaped fixtures.** Rejected: they are noise, but the
three real-file failures were the actual defect, and they are what a green suite
would have hidden once the fixtures were normalized.

## Consequences

The one input this trade costs: a POSIX path with a literal backslash written as
`a\\b.png` keeps both characters instead of collapsing to one. Every spelling a
Windows paste produces — bare `C:\…`, quoted `"C:\…"`, forward-slashed `C:/…` —
now resolves, and a path whose own name contains a space still needs the quoting or
escaping it always did, because the token has already been split by the time the
scanner sees it.

The package's suite is platform-neutral: 32 pass, 0 fail on Windows, and the
POSIX assertions reduce to exactly the literals they replaced.

## Verification

- `plugins/paste-image/test/references.test.ts::only a space or a quote is escaped; a Windows separator is kept` — the tokenizer returns a drive path and a UNC prefix byte-identical to its input, and still resolves a backslash-escaped space.
- `plugins/paste-image/test/references.test.ts::finds a Windows path whole, separators and all` — the scanner's *expression* for a drive path, a quoted path with a space, and a UNC path, which is what `candidatePaths` consumes.
- `plugins/paste-image/test/plugin.test.ts::a real image path becomes image content plus a placeholder` and `plugins/paste-image/test/plugin.test.ts::wires the input hook and transforms through it` — the end-to-end cases: a real file beside the workspace must become `transform` with image content, not `continue`.
- `plugins/paste-image/test/attach.test.ts` — the fixture normalization, which is what makes those three claims readable on both platforms.

Proved: restored the unconditional escape (`if (character === "\\" && index + 1 < text.length)`)
and ran the file: `bun test plugins/paste-image/test/references.test.ts` reported
`12 pass, 2 fail` on the two new cases, and
`bun test plugins/paste-image/test/plugin.test.ts` reported `5 pass, 3 fail` with
`Expected: "transform" / Received: "continue"`. Restored the `isEscape` guard: the
same two files report `14 pass, 0 fail` and `8 pass, 0 fail`, and the whole package
is `32 pass, 0 fail`. Red and green were both measured on win32, which is the
platform the failures were reported on.
