# pi-theme-mytheme

A pi theme ported from MiniMax Code's palette: a neutral grey base, one blue
accent, and Catppuccin for everything that carries meaning.

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

The palette is ported from MiniMax Code's default theme, which solves the same
problem differently and better: a **neutral grey base**, **one blue accent**
(`#68C0FF`), and **Catppuccin** for everything that carries meaning.

| | pi default `dark` | `mytheme` |
|---|---|---|
| base | OKHSL, everything saturated | grey: `text #D6D6D6`, `muted #ADADAD`, `dim #666666`, `border #303030` |
| `accent` | violet | `#68C0FF`, and nothing else competes with it |
| `mdHeading` | yellow `okhsl(83 88% 67%)` | Catppuccin mauve `#CBA6F7` |
| `mdCode` / `mdCodeBlock` | violet / green | Catppuccin green `#A6E3A1` |
| `border` | `okhsl(231 57% 65%)` — bright | `#303030` |
| `toolSuccessBg` / `toolErrorBg` | saturated fills | MiniMax's own `diffAddedBg #213A2B` / `diffRemovedBg #4A221D` — a tint, not a fill |
| `userMessageBg` | blue-tinted | flat neutral `#262626` |
| `syntax*` (12 tokens) | four hues, one lightness band | the full Catppuccin dark set |

The single biggest change is the base. In pi's default, hue is spent everywhere
at once, so nothing is emphasised; here hue is rationed — grey for structure,
blue for interaction, Catppuccin for content.

`toolSuccessBg` and `toolErrorBg` reuse MiniMax's diff backgrounds directly,
which is the one place its palette maps onto pi's tokens without interpretation.

### The thinking ramp is derived, not ported

MiniMax has no equivalent of pi's thinking-level ramp, so this is the one part
that had to be built rather than copied. It sweeps grey → teal → blue → violet →
mauve → peach, using MiniMax's own colours at every step it can:

| Step | Dark | Hue |
|---|---|---|
| `thinkingOff` | `#666666` (MiniMax `dim`) | grey |
| `thinkingMinimal` | `#7FC5CB` (MiniMax teal) | 184.7 |
| `thinkingLow` | `#68C0FF` (MiniMax accent) | 205.0 |
| `thinkingMedium` | `#89B4FA` (Catppuccin blue) | 217.2 |
| `thinkingHigh` | `#A8A6F2` — **derived** | 241.6 |
| `thinkingXhigh` | `#CBA6F7` (Catppuccin mauve) | 267.4 |
| `thinkingMax` | `#FAB387` (Catppuccin peach) | 23.0 — the wrap |

`thinkingHigh` is the only invented value: MiniMax's palette has nothing between
Catppuccin blue (217) and mauve (267), and a step has to sit there for the sweep
to stay monotonic. It is interpolated inside that hue range at the same
lightness as its neighbours. The test asserts the ordering, so a future retune
that flattens the ramp fails rather than passing quietly.

MiniMax ships three more palettes — Midnight, Graphite and Aurora — which are
the same construction with a different accent. They are not ported here; one
theme that works beats four nobody chose between.

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
