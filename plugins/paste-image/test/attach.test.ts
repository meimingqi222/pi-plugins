import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { attachImageReferences, candidatePaths, placeholder } from "../src/attach.ts";
import { PNG_1X1_BASE64, stubEnv } from "./fixtures.ts";

const IMAGE = { mimeType: "image/png", base64: PNG_1X1_BASE64 };

/**
 * The virtual POSIX paths below are spelled the way the platform's `path` module
 * would hand them to a loader. `candidatePaths` absolutizes against its own
 * primitives, so on Windows the same input becomes `\var\folders\tmp\a.png` and a
 * relative name picks up the drive of `process.cwd()`; `joined` is the shape
 * `path.join` produces (no drive), `resolved` the shape `path.resolve` produces.
 * On POSIX the two are the same string, which is why the distinction was easy to
 * miss.
 */
const joined = (...parts: string[]): string => path.normalize(path.join(...parts));
const resolved = (...parts: string[]): string => path.resolve(...parts);

describe("candidatePaths", () => {
	const env = { cwd: "/work/project", home: "/Users/me", tmpdir: "/var/folders/tmp" };

	test("an absolute path is the only candidate", () => {
		expect(candidatePaths("/var/folders/tmp/a.png", env)).toEqual([joined("/var/folders/tmp/a.png")]);
	});

	test("~ resolves against home", () => {
		expect(candidatePaths("~/Pictures/a.png", env)).toEqual([joined(env.home, "Pictures", "a.png")]);
	});

	test("a relative path tries cwd, only clipboard basenames try the temp dir", () => {
		expect(candidatePaths("img/a.png", env)).toEqual([resolved(env.cwd, "img", "a.png")]);
		expect(candidatePaths("a.png", env)).toEqual([resolved(env.cwd, "a.png")]);
        expect(candidatePaths("pi-clipboard-test.png", env)).toEqual([
          resolved(env.cwd, "pi-clipboard-test.png"), joined(env.tmpdir, "pi-clipboard-test.png"),
        ]);
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
			resolved(env.cwd, "pi-clipboard-ca49e04e.png"),
			joined(env.tmpdir, "pi-clipboard-ca49e04e.png"),
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

test("attachment count includes existing images and is bounded", async () => {
  const env = { cwd: '/work', home: '/home/me', tmpdir: '/tmp', load: async () => ({ mimeType: 'image/png', base64: 'fake' }) };
  const result = await attachImageReferences(Array.from({ length: 100 }, (_, i) => `picture-${i}.png`).join(' '), env, 18);
  expect(result.images.length).toBe(2);
  expect(result.text).toContain('picture-2.png');
});
test("an ordinary basename cannot attach a same-named temp file", () => {
  expect(candidatePaths('residual.png', { cwd: '/work', home: '/home/me', tmpdir: '/tmp' })).toEqual(['/work/residual.png']);
});

test("the aggregate attachment bytes are bounded", async () => {
  const base64 = 'A'.repeat(24 * 1024 * 1024); // 18 MiB decoded per image.
  const env = { cwd: '/work', home: '/home/me', tmpdir: '/tmp', load: async () => ({ mimeType: 'image/png', base64 }) };
  const result = await attachImageReferences('first.png second.png', env);
  expect(result.images).toHaveLength(1);
  expect(result.text).toContain('second.png');
});
