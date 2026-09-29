import { describe, expect, test } from "bun:test";
import { rewriteReferences, scanImageReferences, tokenize } from "../src/references.ts";

/** The expressions a scan finds, which is what every other assertion is about. */
function expressions(text: string): string[] {
	return scanImageReferences(text).map((reference) => reference.expression);
}

describe("tokenize", () => {
	test("resolves quotes and backslash escapes without losing offsets", () => {
		const text = "a \"My Shot.png\" b My\\ Shot.png c";
		const tokens = tokenize(text);
		expect(tokens.map((token) => token.value)).toEqual(["a", "My Shot.png", "b", "My Shot.png", "c"]);
		expect(tokens[1]).toEqual({ start: 2, end: 15, value: "My Shot.png" });
		expect(text.slice(tokens[1]!.start, tokens[1]!.end)).toBe("\"My Shot.png\"");
	});
});

describe("scanImageReferences", () => {
	test("finds a pasted clipboard path in prose", () => {
		const text = "/var/folders/tl/x/T/pi-clipboard-ca49e04e.png 这个 auto 是什么？";
		const [reference] = scanImageReferences(text);
		expect(reference?.expression).toBe("/var/folders/tl/x/T/pi-clipboard-ca49e04e.png");
		expect(reference?.raw).toBe("/var/folders/tl/x/T/pi-clipboard-ca49e04e.png");
		expect(reference?.start).toBe(0);
	});

	test("strips the punctuation a path is wrapped in, and adds nothing else", () => {
		expect(expressions("see (/tmp/a.png).")).toEqual(["/tmp/a.png"]);
		expect(expressions("- /tmp/a.png, - /tmp/b.jpg;")).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
	});

	test("a path with an unescaped space is not guessed at", () => {
		// Terminal drag-and-drop escapes (`My\ Shot.png`) or quotes the path; a raw
		// space splits it, and half a path must not turn into a wrong attachment.
		expect(expressions("/tmp/shot (1).png")).toEqual([]);
		expect(expressions("\"/tmp/shot (1).png\"")).toEqual(["/tmp/shot (1).png"]);
		expect(expressions("/tmp/My\\ Shot.png")).toEqual(["/tmp/My Shot.png"]);
	});

	test("reads file:// URLs, including percent-encoding", () => {
		expect(expressions("file:///Users/me/My%20Shot.png")).toEqual(["/Users/me/My Shot.png"]);
		expect(expressions("file://localhost/Users/me/a.png")).toEqual(["/Users/me/a.png"]);
	});

	test("reads the @file-mention form", () => {
		expect(expressions("@img/logo.webp")).toEqual(["img/logo.webp"]);
	});

	test("ignores text that is not an image path", () => {
		expect(expressions("no path here at all")).toEqual([]);
		expect(expressions("/tmp/report.pdf and /tmp/a.png.bak")).toEqual([]);
		expect(expressions("see README.md")).toEqual([]);
	});

	test("ignores paths inside fenced code and inline code", () => {
		const fenced = ["Fix line 3:", "```md", "![logo](./logo.png)", "```", "then /tmp/real.png"].join("\n");
		expect(expressions(fenced)).toEqual(["/tmp/real.png"]);

		// Inline code is text *about* a path: a quote, a snippet, a README line.
		expect(expressions("the docs say `![logo](./logo.png)` and /tmp/real.png is the one")).toEqual(["/tmp/real.png"]);
		expect(expressions("look at `/tmp/a.png`")).toEqual([]);
		expect(expressions("``a`b/logo.png``")).toEqual([]);
	});

	test("a fence never swallows text after its closing marker", () => {
		const text = ["```sh", "ls /tmp/inside.png", "```", "ls /tmp/after.png"].join("\n");
		expect(expressions(text)).toEqual(["/tmp/after.png"]);
	});

	test("finds several references in one line, in order", () => {
		expect(expressions("/tmp/a.png /tmp/b.png /tmp/a.png")).toEqual(["/tmp/a.png", "/tmp/b.png", "/tmp/a.png"]);
	});
});

describe("rewriteReferences", () => {
	test("replaces whole tokens, quotes included", () => {
		const text = "what is \"My Shot.png\" doing?";
		const references = scanImageReferences(text);
		expect(references).toHaveLength(1);
		expect(rewriteReferences(text, [{ reference: references[0]!, placeholder: "[#image 1]" }])).toBe(
			"what is [#image 1] doing?",
		);
	});

	test("keeps the text byte-identical when there is nothing to replace", () => {
		expect(rewriteReferences("nothing here", [])).toBe("nothing here");
	});
});
