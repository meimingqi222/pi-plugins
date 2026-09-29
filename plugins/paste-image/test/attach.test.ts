import { describe, expect, test } from "bun:test";
import { attachImageReferences, candidatePaths, placeholder } from "../src/attach.ts";
import { PNG_1X1_BASE64, stubEnv } from "./fixtures.ts";

const IMAGE = { mimeType: "image/png", base64: PNG_1X1_BASE64 };

describe("candidatePaths", () => {
	const env = { cwd: "/work/project", home: "/Users/me", tmpdir: "/var/folders/tmp" };

	test("an absolute path is the only candidate", () => {
		expect(candidatePaths("/var/folders/tmp/a.png", env)).toEqual(["/var/folders/tmp/a.png"]);
	});

	test("~ resolves against home", () => {
		expect(candidatePaths("~/Pictures/a.png", env)).toEqual(["/Users/me/Pictures/a.png"]);
	});

	test("a relative path tries the cwd first, a bare name also the temp dir", () => {
		expect(candidatePaths("img/a.png", env)).toEqual(["/work/project/img/a.png"]);
		expect(candidatePaths("a.png", env)).toEqual(["/work/project/a.png", "/var/folders/tmp/a.png"]);
	});
});

describe("attachImageReferences", () => {
	test("attaches a pasted clipboard path and leaves a placeholder", async () => {
		const text = "/var/folders/tmp/pi-clipboard-ca49e04e.png 这个 auto 是什么？";
		const env = stubEnv({ "/var/folders/tmp/pi-clipboard-ca49e04e.png": IMAGE });
		const result = await attachImageReferences(text, env);
		expect(result.attached).toBe(1);
		expect(result.text).toBe(`${placeholder(1)} 这个 auto 是什么？`);
		expect(result.images).toEqual([{ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }]);
	});

	test("resolves a bare filename out of pi's temp directory", async () => {
		const env = stubEnv({ "/var/folders/tmp/pi-clipboard-ca49e04e.png": IMAGE });
		expect(env.loaded).toEqual([]);
		const result = await attachImageReferences("have a look at pi-clipboard-ca49e04e.png", env);
		expect(result.attached).toBe(1);
		expect(result.text).toBe("have a look at [#image 1]");
		// The cwd candidate is tried first: only the second one exists.
		expect(env.loaded).toEqual([
			"/work/project/pi-clipboard-ca49e04e.png",
			"/var/folders/tmp/pi-clipboard-ca49e04e.png",
		]);
	});

	test("numbers distinct images in first-reference order and reuses a repeat", async () => {
		const env = stubEnv({
			"/tmp/a.png": IMAGE,
			"/tmp/b.png": { mimeType: "image/png", base64: "b" },
		});
		const result = await attachImageReferences("/tmp/a.png and /tmp/b.png and /tmp/a.png again", env);
		expect(result.attached).toBe(3);
		expect(result.text).toBe("[#image 1] and [#image 2] and [#image 1] again");
		expect(result.images).toHaveLength(2);
		expect(result.images.map((image) => image.data)).toEqual([PNG_1X1_BASE64, "b"]);
	});

	test("leaves the text alone when the reference is not an image", async () => {
		const text = "what changed in /tmp/report.pdf?";
		const result = await attachImageReferences(text, stubEnv({}));
		expect(result.attached).toBe(0);
		expect(result.text).toBe(text);
		expect(result.images).toEqual([]);
	});

	test("leaves the text alone when the file vanished between paste and submit", async () => {
		const text = "/var/folders/tmp/pi-clipboard-gone.png";
		const result = await attachImageReferences(text, stubEnv({}));
		expect(result.attached).toBe(0);
		expect(result.text).toBe(text);
	});

	test("a loader that throws is treated as a miss, not a failure", async () => {
		const env = stubEnv({});
		const result = await attachImageReferences("/tmp/a.png", {
			...env,
			load: async () => {
				throw new Error("EACCES");
			},
		});
		expect(result.attached).toBe(0);
		expect(result.text).toBe("/tmp/a.png");
	});
});
