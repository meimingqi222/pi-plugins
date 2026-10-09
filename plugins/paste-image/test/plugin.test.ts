import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import pasteImageExtension, { createAttachEnv, transformInput } from "../src/index.ts";
import { PNG_1X1, PNG_1X1_BASE64, model } from "./fixtures.ts";

let workspace: string;

beforeAll(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "pi-paste-image-"));
	await writeFile(path.join(workspace, "shot.png"), PNG_1X1);
	await writeFile(path.join(workspace, "notes.md"), "# notes\n");
	// A `.png` name over bytes that are not a PNG: the extension must ask pi's
	// sniffer rather than trust the extension.
	await writeFile(path.join(workspace, "notreally.png"), "this is not an image\n");
});

afterAll(async () => {
	await rm(workspace, { recursive: true, force: true });
});

function ctx(overrides: Partial<Pick<ExtensionContext, "cwd" | "model">> = {}): ExtensionContext {
	return { cwd: workspace, model: model(["text", "image"]), ...overrides } as unknown as ExtensionContext;
}

function fakePi(): { api: ExtensionAPI; handlers: Map<string, (event: InputEvent, context: ExtensionContext) => unknown> } {
	const handlers = new Map<string, (event: InputEvent, context: ExtensionContext) => unknown>();
	const api = {
		on: (event: string, handler: (input: InputEvent, context: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

describe("transformInput", () => {
	test("a real image path becomes image content plus a placeholder", async () => {
		const file = path.join(workspace, "shot.png");
		const result = await transformInput(`${file} 这个 auto 是什么？`, undefined, ctx(), createAttachEnv(workspace));
		expect(result.action).toBe("transform");
		if (result.action !== "transform") return;
		expect(result.text).toBe("[#image 1] 这个 auto 是什么？");
		expect(result.images).toEqual([{ type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }]);
	});

	test("images a caller already attached are preserved", async () => {
		const existing = { type: "image", data: "existing", mimeType: "image/jpeg" } as const;
		const file = path.join(workspace, "shot.png");
		const result = await transformInput(file, [existing], ctx(), createAttachEnv(workspace));
		expect(result.action).toBe("transform");
		if (result.action !== "transform") return;
		expect(result.images).toEqual([existing, { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" }]);
	});

	test("mixed attachments number new files after existing images and reuse repeated paths", async () => {
		const existing = { type: "image", data: "existing", mimeType: "image/jpeg" } as const;
		const env = { cwd: workspace, home: workspace, tmpdir: workspace,
			load: async (file: string) => ({ mimeType: "image/png", base64: path.basename(file) }) };
		const result = await transformInput("a.png b.png a.png", [existing], ctx(), env);
		expect(result.action).toBe("transform");
		if (result.action !== "transform") return;
		expect(result.text).toBe("[#image 2] [#image 3] [#image 2]");
		expect(result.images?.map(image => image.data)).toEqual(["existing", "a.png", "b.png"]);
	});

	test("a .png name over non-image bytes is left alone", async () => {
		const result = await transformInput(
			`what is ${path.join(workspace, "notreally.png")}?`,
			undefined,
			ctx(),
			createAttachEnv(workspace),
		);
		expect(result).toEqual({ action: "continue" });
	});

	test("a text file is left alone", async () => {
		const result = await transformInput(
			`summarize ${path.join(workspace, "notes.md")}`,
			undefined,
			ctx(),
			createAttachEnv(workspace),
		);
		expect(result).toEqual({ action: "continue" });
	});

	test("a path that does not exist is left alone", async () => {
		const result = await transformInput(
			`see ${path.join(workspace, "ghost.png")}`,
			undefined,
			ctx(),
			createAttachEnv(workspace),
		);
		expect(result).toEqual({ action: "continue" });
	});

	test("a model without image input keeps the path it can still act on", async () => {
		const file = path.join(workspace, "shot.png");
		const result = await transformInput(
			`${file} what is this?`,
			undefined,
			ctx({ model: model(["text"]) }),
			createAttachEnv(workspace),
		);
		expect(result).toEqual({ action: "continue" });
	});
});

describe("pasteImageExtension", () => {
	test("wires the input hook and transforms through it", async () => {
		const { api, handlers } = fakePi();
		pasteImageExtension(api);
		const handler = handlers.get("input");
		expect(handler).toBeDefined();
		if (!handler) return;
		const file = path.join(workspace, "shot.png");
		const result = (await handler(
			{ type: "input", text: `${file} look`, source: "interactive" },
			ctx(),
		)) as InputEventResult;
		expect(result.action).toBe("transform");
		if (result.action !== "transform") return;
		expect(result.text).toBe("[#image 1] look");
	});

	test("a prompt with no image reference is untouched", async () => {
		const { api, handlers } = fakePi();
		pasteImageExtension(api);
		const handler = handlers.get("input");
		if (!handler) return;
		expect(await handler({ type: "input", text: "just a question", source: "interactive" }, ctx())).toEqual({
			action: "continue",
		});
	});
});
