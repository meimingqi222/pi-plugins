import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A theme is data, so the failures that matter are data failures: a missing
 * token, an unknown token, a colour value pi cannot parse, a variable reference
 * to nothing. This suite checks exactly those, and nothing about how the result
 * looks — that is a human judgement, and a test that asserted hex values would
 * only ever re-pin whatever was written last.
 *
 * It deliberately does **not** call pi's own `loadThemeFromPath`. That function
 * exists in the pi release a session runs (1.4.x), but the workspace resolves
 * `@earendil-works/pi-coding-agent` to 1.0.0, which does not export it — so a
 * test written against the loader would fail here for a version reason while
 * the theme itself is fine. The checks below are the schema's own rules.
 */

const themesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "themes");
const themeFiles = readdirSync(themesDir).filter((name) => name.endsWith(".json")).sort();

/** Tokens the schema marks required. */
const REQUIRED_TOKENS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
	"muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg", "userMessageText",
	"customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
	"toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink",
	"mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString",
	"syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
	"thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
	"bashMode",
] as const;

/** Tokens the schema allows with a fallback. Declared anyway, so nothing depends on a fallback. */
const OPTIONAL_TOKENS = [
	"scrollbarTrack", "scrollbarThumb", "searchMatchBg", "searchMatchText", "thinkingMax",
] as const;

const ALL_TOKENS = new Set<string>([...REQUIRED_TOKENS, ...OPTIONAL_TOKENS]);

/** `#RGB`, `#RRGGBB`, `okhsl(...)`, `oklch(...)`, or empty for the terminal default. */
const COLOR_VALUE = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|okhsl\([^)]*\)|oklch\([^)]*\)|)$/u;

/**
 * Hue of a colour, whichever notation it is written in.
 *
 * The theme is a hex port, so the ramp check has to read hex; a theme written in
 * OKHSL should still pass, which is why both are handled.
 */
function hueOf(value: unknown): number | undefined {
	const text = String(value);
	const okhsl = /okhsl\(\s*([\d.]+)/u.exec(text);
	if (okhsl) return Number(okhsl[1]);
	const hex = /^#([0-9a-fA-F]{6})$/u.exec(text.trim());
	if (!hex) return undefined;
	const channel = Number.parseInt(hex[1]!, 16);
	const r = ((channel >> 16) & 255) / 255;
	const g = ((channel >> 8) & 255) / 255;
	const b = (channel & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max === min) return 0; // grey: no hue, reported as 0 so it sorts first
	const delta = max - min;
	let hue: number;
	if (max === r) hue = ((g - b) / delta) % 6;
	else if (max === g) hue = (b - r) / delta + 2;
	else hue = (r - g) / delta + 4;
	hue *= 60;
	return hue < 0 ? hue + 360 : hue;
}

interface ThemeFile {
	name?: unknown;
	appearance?: unknown;
	vars?: unknown;
	colors?: unknown;
	export?: unknown;
}

function readTheme(file: string): ThemeFile {
	return JSON.parse(readFileSync(join(themesDir, file), "utf8")) as ThemeFile;
}

function varNames(theme: ThemeFile): Set<string> {
	const vars = theme.vars;
	if (!vars || typeof vars !== "object" || Array.isArray(vars)) return new Set();
	return new Set(Object.keys(vars as Record<string, unknown>));
}

describe("pi-theme-mytheme", () => {
	test("ships a dark theme and a light theme", () => {
		expect(themeFiles.length).toBeGreaterThan(0);
		const appearances = themeFiles.map((file) => String(readTheme(file).appearance));
		expect(appearances).toContain("dark");
		expect(appearances).toContain("light");
	});

	test("every theme names itself, and the names are unique", () => {
		// The resource loader dedupes by name and reports a collision, so two
		// files claiming one name silently drop one of them from /theme.
		const names = themeFiles.map((file) => String(readTheme(file).name));
		for (const name of names) {
			expect(name).not.toBe("undefined");
			expect(name).not.toContain("/");
		}
		expect(new Set(names).size).toBe(names.length);
	});

	test("appearance is dark or light", () => {
		for (const file of themeFiles) {
			expect(["dark", "light"]).toContain(String(readTheme(file).appearance));
		}
	});

	test.each(themeFiles)("%s declares every required token", (file) => {
		const colors = readTheme(file).colors as Record<string, unknown>;
		expect(Object.keys(colors).filter((token) => REQUIRED_TOKENS.includes(token as never))).toHaveLength(REQUIRED_TOKENS.length);
	});

	test.each(themeFiles)("%s declares no token outside the schema", (file) => {
		// `additionalProperties: false`: a well-meant extra key is a load failure,
		// not a harmless extra.
		const colors = readTheme(file).colors as Record<string, unknown>;
		expect(Object.keys(colors).filter((token) => !ALL_TOKENS.has(token))).toEqual([]);
	});

	test.each(themeFiles)("%s gives every token a value pi can parse", (file) => {
		const theme = readTheme(file);
		const vars = varNames(theme);
		const bad: string[] = [];
		for (const [token, value] of Object.entries(theme.colors as Record<string, unknown>)) {
			if (typeof value === "number") {
				// A 256-colour palette index.
				if (!Number.isInteger(value) || value < 0 || value > 255) bad.push(`${token}=${value}`);
				continue;
			}
			if (typeof value !== "string") {
				bad.push(`${token}=${typeof value}`);
				continue;
			}
			// A bare word is a `vars` reference; anything else must be a literal.
			if (!COLOR_VALUE.test(value) && !vars.has(value)) bad.push(`${token}=${value}`);
		}
		expect(bad).toEqual([]);
	});

	test.each(themeFiles)("%s resolves every variable its own vars reference", (file) => {
		// `vars` entries may reference each other, which is how a palette stays
		// consistent — and how a typo becomes a load failure.
		const theme = readTheme(file);
		const vars = (theme.vars ?? {}) as Record<string, unknown>;
		const names = new Set(Object.keys(vars));
		const dangling = Object.entries(vars)
			.filter(([, value]) => typeof value === "string" && !COLOR_VALUE.test(value) && !names.has(value))
			.map(([key]) => key);
		expect(dangling).toEqual([]);
	});

	test.each(themeFiles)("%s orders the thinking ramp and wraps only at the top", (file) => {
		// The ramp is pi's one genuinely distinctive feature: thinking depth as a
		// hue sweep. Flattening it — repeating a hue, or wrapping early — turns
		// the level indicator into noise, and nothing else would notice.
		const colors = readTheme(file).colors as Record<string, unknown>;
		const steps = ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh"];
		const ramp = steps.map((token) => hueOf(colors[token]));
		for (const hue of ramp) expect(hue).toBeDefined();
		const numbers = ramp as number[];
		for (let index = 1; index < numbers.length; index += 1) {
			expect(numbers[index]).toBeGreaterThanOrEqual(numbers[index - 1]!);
		}
		// The last step is the wrap: past magenta back into the warm end, which
		// means it lands *below the first chromatic step* rather than continuing
		// upward. Comparing against `numbers[0]` would be wrong — that step is
		// grey, hue 0, and nothing sorts under it.
		const top = hueOf(colors.thinkingMax);
		expect(top).toBeLessThan(60);
		expect(top).toBeLessThan(numbers[1]!);
	});
});
