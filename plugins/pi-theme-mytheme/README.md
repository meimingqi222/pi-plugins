# pi-theme-mytheme

A calm theme for pi. One violet accent, low-chroma surfaces, and markdown that
stops shouting.

Install it like any other plugin in this workspace:

```bash
pi install -l ./plugins/pi-theme-mytheme
```

Then either pick it in `/theme`, or set it in `~/.pi/agent/settings.json`:

```json
{ "theme": "mytheme" }
```

`mytheme-light` ships alongside it for a light terminal; `theme` can also be
`auto` to follow the terminal's own report.

## What it changes

pi's default `dark` theme is not badly built — its token set is richer than most
terminal themes get. What it does is spend that richness all at once: a
near-maximally saturated yellow on every markdown heading, four different hues
inside ordinary body text, a bright border, and a saturated background behind
every tool call. Nothing is emphasised because everything is.

This theme keeps pi's own vocabulary and re-establishes a hierarchy:

| | default `dark` | `mytheme` |
|---|---|---|
| `mdHeading` | yellow `okhsl(83 88% 67%)` | violet — the accent, and nothing else competes with it |
| `mdCodeBlock` | green, saturated | desaturated green, only inside code blocks |
| `border` | `okhsl(231 57% 65%)` | `okhsl(235 11% 33%)` |
| `toolSuccessBg` / `toolErrorBg` | `okhsl(158 46% 25%)` / `okhsl(19 54% 25%)` | `okhsl(150 16% 18%)` / `okhsl(8 26% 19%)` — a tint, not a fill |
| `userMessageBg` | blue | violet-tinted, so the band belongs to the accent |

Violet stays the accent on purpose. It is pi's only strong visual identity, and
replacing it with another product's blue buys nothing that a calmer value set
does not already buy.

The thinking ramp is left as a ramp — `thinkingOff` through `thinkingMax` still
sweeps gray → blue → violet → magenta → red, wrapping only at the top. It is the
one place pi turns a setting into something you can see, and it is worth keeping.

## Layout

This package carries **no extension code**. Pi discovers themes from a package's
`themes/` directory or from a `pi.themes` manifest glob, so a theme needs no
`extensions` entry, registers nothing, and cannot affect a session. The manifest
is:

```json
{ "pi": { "themes": ["./themes/*.json"] } }
```

Anything that changes *layout* rather than colour — the one-line tool rows, the
collapsed thinking blocks, a labelled status line — is not a theme and does not
belong here. Those need an extension; see the follow-up work in
`.agents/notes/`.

## Files

| File | What it is |
|---|---|
| `themes/mytheme.json` | the dark theme, name `mytheme` |
| `themes/mytheme-light.json` | the light theme, name `mytheme-light` |
| `test/theme.test.ts` | the data checks below |

Both files declare all 56 tokens the schema allows, including the five that have
fallbacks, so nothing depends on a fallback silently changing.

## Tests

A theme is data, so the failures that matter are data failures. The suite checks
that both files declare every required token, declare no token outside the
schema (`additionalProperties: false`, so an extra key is a load failure rather
than a harmless extra), give every token a value pi can parse — a literal
`#RRGGBB` / `okhsl()` / `oklch()`, a 0–255 palette index, or a `vars` reference
that resolves — and keep the thinking ramp ordered with a single wrap at the top.

It deliberately does not call pi's own `loadThemeFromPath`: that export exists in
the pi release a session runs, but the workspace resolves
`@earendil-works/pi-coding-agent` to 1.0.0, which does not have it, so a test
written against the loader would fail here for a version reason while the theme
is fine. The checks are the schema's own rules.

Nothing asserts a hex value. A test that pinned the palette would only ever
re-pin whatever was written last, and would fail on the next deliberate retune.

```bash
bun run --filter @meimingqi222/pi-theme-mytheme test
```
