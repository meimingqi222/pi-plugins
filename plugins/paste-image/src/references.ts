/**
 * Finding image references in submitted text.
 *
 * An image reaches pi's editor as a path, never as bytes: the clipboard paste
 * writes the clipboard to a temp PNG and inserts that path, and a terminal
 * drag-and-drop inserts a path too. This module finds those references without
 * touching the filesystem, so the cases that actually break in practice —
 * `file://` URLs, macOS screenshot names with spaces, quoted or shell-escaped
 * paths, Windows paths whose separators are backslashes, several references in
 * one line — are unit-testable from strings alone.
 * Whether a candidate really is an image is decided later, in `attach.ts`.
 *
 * Deliberately not supported: prose that names a path inside a code fence or an
 * inline code span (`![logo](./logo.png)` in a README quote, a shell snippet).
 * Those are text *about* a path, and replacing them would corrupt the quote.
 */

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp)$/iu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;
const LEADING_BRACKETS = "([{<";
const CLOSING_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const FENCE = /^[ \t]*(`{3,}|~{3,})/u;

export interface ImageReference {
	/** Offset of the first character of the raw token, quotes included. */
	start: number;
	/** Offset one past the last character of the raw token. */
	end: number;
	/** The token exactly as the user typed or pasted it. */
	raw: string;
	/** The path to resolve: quotes and escapes removed, `file://` and `@` stripped. */
	expression: string;
}

export interface Token {
	start: number;
	end: number;
	/** The token with quotes removed and `\` escapes resolved. */
	value: string;
}

interface Range {
	start: number;
	end: number;
}

function isWhitespace(character: string): boolean {
	return character === " " || character === "\t" || character === "\n" || character === "\r";
}

/**
 * Whether a backslash before `next` is an escape rather than a path character.
 *
 * Only the two things a shell needs an escape *for* count: writing a space or a
 * quote inside one bare word. Everything else keeps the backslash, because the
 * paste that puts a path in the editor writes a Windows path —
 * `C:\Users\me\shot.png`, or a `\\server\share` UNC prefix — and consuming those
 * separators would name a file that does not exist. A quoted path (`"C:\a b.png"`)
 * never reaches this decision: quotes are handled as their own span.
 */
function isEscape(next: string): boolean {
	return isWhitespace(next) || next === '"' || next === "'";
}

/**
 * Split text into whitespace-delimited tokens while honouring the two ways a
 * path with spaces is written: `"My Shot.png"` and `My\ Shot.png`. A backslash
 * elsewhere is a path character, not an escape — see `isEscape`. The token
 * keeps the offsets of what it occupies in the original text, so a rewrite can
 * replace the whole thing — quotes included — instead of leaving `"` behind.
 */
export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let start = -1;
	let value = "";
	let quote: string | undefined;

	const flush = (end: number): void => {
		if (start >= 0 && value.length > 0) tokens.push({ start, end, value });
		start = -1;
		value = "";
		quote = undefined;
	};

	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (start < 0) {
			if (isWhitespace(character)) continue;
			start = index;
			if (character === '"' || character === "'") {
				quote = character;
				continue;
			}
			value = character;
			continue;
		}
		if (character === "\\" && index + 1 < text.length && isEscape(text[index + 1]!)) {
			// A backslash escape where a shell needs one: `My\ Shot.png`.
			value += text[index + 1]!;
			index += 1;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else value += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (isWhitespace(character)) {
			flush(index);
			continue;
		}
		value += character;
	}
	flush(text.length);
	return tokens;
}

/**
 * Reduce a token to the path it names, or `undefined` when it names nothing.
 *
 * Punctuation around a pasted path is never part of it: `(/tmp/a.png)`,
 * `see /tmp/a.png.` and `` `/tmp/a.png` `` all name the same file. Only
 * *unmatched* brackets are stripped, so a filename that really contains one
 * survives.
 */
function toExpression(value: string): string | undefined {
	let expression = value.trim();
	let strippedBracket = false;
	for (const bracket of LEADING_BRACKETS) {
		while (expression.startsWith(bracket)) {
			expression = expression.slice(1);
			strippedBracket = true;
		}
	}
	const count = (character: string): number => [...expression].filter((one) => one === character).length;
	// `(/tmp/a.png).` needs both rules, and either one can expose the other, so
	// strip until the expression stops changing.
	for (let changed = true; changed; ) {
		changed = false;
		const trimmed = expression.replace(TRAILING_PUNCTUATION, "");
		if (trimmed !== expression) {
			expression = trimmed;
			changed = true;
		}
		while (expression.length > 0) {
			const last = expression.at(-1)!;
			const opener = CLOSING_BRACKETS[last];
			if (opener === undefined || count(last) <= count(opener)) break;
			expression = expression.slice(0, -1);
			changed = true;
		}
	}
	if (expression.length === 0) return undefined;
	// `Shot (1).png` splits on its space, so the tail `(1).png` looks like a bare
	// filename. It is a fragment of a path this scanner cannot see, and attaching
	// `1.png` from the cwd would be a wrong image, so it is not a reference at all.
	if (strippedBracket && !expression.includes("/") && !expression.includes("\\")) return undefined;

	// `file:///Users/me/a.png` — what browsers, some terminals and pi's own
	// HTML export emit. A `localhost` (or empty) authority is not part of the path.
	const fileUrl = /^file:\/\/(.*)$/iu.exec(expression);
	if (fileUrl) {
		const withoutAuthority = fileUrl[1]!.replace(/^localhost/iu, "");
		try {
			expression = decodeURIComponent(withoutAuthority);
		} catch {
			expression = withoutAuthority;
		}
	}

	// pi's file-mention syntax names the same file (`@img/a.png`).
	if (expression.startsWith("@")) expression = expression.slice(1);
	return expression.length > 0 ? expression : undefined;
}

function lineRanges(text: string): Range[] {
	const ranges: Range[] = [];
	let start = 0;
	for (let index = 0; index <= text.length; index += 1) {
		if (index === text.length || text[index] === "\n") {
			ranges.push({ start, end: index });
			start = index + 1;
		}
	}
	return ranges;
}

/** Fenced code blocks, including their fence lines. */
function fencedRanges(text: string): Range[] {
	const all = lineRanges(text);
	const ranges: Range[] = [];
	for (let line = 0; line < all.length; line += 1) {
		const open = FENCE.exec(text.slice(all[line]!.start, all[line]!.end));
		if (!open) continue;
		const marker = open[1]!;
		let last = line;
		for (let candidate = line + 1; candidate < all.length; candidate += 1) {
			const close = FENCE.exec(text.slice(all[candidate]!.start, all[candidate]!.end));
			if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
				last = candidate;
				break;
			}
		}
		ranges.push({ start: all[line]!.start, end: all[last]!.end });
		line = last;
	}
	return ranges;
}

function inside(ranges: ReadonlyArray<Range>, offset: number): boolean {
	return ranges.some((range) => offset >= range.start && offset < range.end);
}

/** Inline code spans outside fences: `` `a.png` `` and ``` ``a.png`` ```. */
function inlineCodeRanges(text: string, fenced: ReadonlyArray<Range>): Range[] {
	const ranges: Range[] = [];
	let index = 0;
	while (index < text.length) {
		if (inside(fenced, index) || text[index] !== "`") {
			index += 1;
			continue;
		}
		let run = 0;
		while (text[index + run] === "`") run += 1;
		const marker = "`".repeat(run);
		const close = text.indexOf(marker, index + run);
		if (close < 0) {
			index += run;
			continue;
		}
		ranges.push({ start: index, end: close + run });
		index = close + run;
	}
	return ranges;
}

/**
 * Every candidate image reference in `text`, in the order it appears. A
 * candidate is a token that ends in a known image extension; existence and
 * real image bytes are the filesystem's job, not this module's.
 */
export function scanImageReferences(text: string): ImageReference[] {
	if (!text.includes(".")) return [];
	const fenced = fencedRanges(text);
	const code = [...fenced, ...inlineCodeRanges(text, fenced)];
	const references: ImageReference[] = [];
	for (const token of tokenize(text)) {
		if (inside(code, token.start)) continue;
		const expression = toExpression(token.value);
		if (expression === undefined || !IMAGE_EXTENSION.test(expression)) continue;
		references.push({ start: token.start, end: token.end, raw: text.slice(token.start, token.end), expression });
	}
	return references;
}

/**
 * Replace each planned reference with its placeholder. Offsets come from
 * `scanImageReferences` on the same text, so building left to right is exact;
 * an overlapping plan is skipped rather than allowed to duplicate text.
 */
export function rewriteReferences(
	text: string,
	replacements: ReadonlyArray<{ reference: ImageReference; placeholder: string }>,
): string {
	const ordered = [...replacements].sort((left, right) => left.reference.start - right.reference.start);
	let output = "";
	let cursor = 0;
	for (const { reference, placeholder } of ordered) {
		if (reference.start < cursor) continue;
		output += text.slice(cursor, reference.start) + placeholder;
		cursor = reference.end;
	}
	return output + text.slice(cursor);
}
