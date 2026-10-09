/**
 * pi-paste-image: a pasted image arrives as image content, not as a path.
 *
 * Why this exists: pi's clipboard paste writes the clipboard to
 * `<tmpdir>/pi-clipboard-<uuid>.png` and inserts that path into the editor as
 * text, and a terminal drag-and-drop inserts a path too. The model then has to
 * decide, unprompted, to call `read` on it — and while it hasn't, the request
 * that reaches the provider contains a path where the user meant an image.
 * Providers are not uniform about that: an image-shaped reference (a `file://`
 * URL, a bare path, a remote URL) is rejected outright by some upstreams, and a
 * proxy that forwards the reference verbatim turns one pasted screenshot into a
 * conversation-wide failure.
 *
 * This extension closes the gap on pi's side: on `input`, image references are
 * read, attached as `ImageContent`, and replaced in the text with `[#image N]`.
 * Nothing path- or URL-shaped leaves the machine, and the model needs no extra
 * `read` round trip to see the picture.
 *
 * It attaches only when the current model declares image input. With a
 * text-only model the path is left alone, because a path is still actionable
 * (`read`, `bash`, OCR) while an attached image the model cannot see is not.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@earendil-works/pi-coding-agent";
import { attachImageReferences, DEFAULT_MAX_SOURCE_BYTES, type AttachEnv, type InlineImage, type LoadedImage } from "./attach.ts";

export { attachImageReferences, candidatePaths, DEFAULT_MAX_SOURCE_BYTES, placeholder } from "./attach.ts";
export type { AttachEnv, AttachResult, InlineImage, LoadedImage } from "./attach.ts";
export { rewriteReferences, scanImageReferences, tokenize } from "./references.ts";
export type { ImageReference, Token } from "./references.ts";

async function loadImageFile(filePath: string, maxBytes: number): Promise<LoadedImage | undefined> {
	try {
		const info = await stat(filePath);
		if (!info.isFile() || info.size === 0 || info.size > maxBytes) return undefined;
		// pi's own sniffer, so anything this plugin attaches is something pi's
		// image pipeline accepts: the same PNG/APNG, JPEG, GIF, WebP and BMP rules,
		// including the rejection of animated PNGs.
		const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
		if (!mimeType) return undefined;
		const bytes = await readFile(filePath);
		return { mimeType, base64: bytes.toString("base64") };
	} catch {
		// Missing, unreadable, a directory, a vanished temp file: leave the text
		// exactly as the user submitted it.
		return undefined;
	}
}

export function createAttachEnv(cwd: string, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES): AttachEnv {
	return {
		cwd,
		home: homedir(),
		tmpdir: tmpdir(),
		load: (filePath) => loadImageFile(filePath, maxSourceBytes),
	};
}

function modelAcceptsImages(model: ExtensionContext["model"]): boolean {
	return model?.input?.includes("image") ?? false;
}

/**
 * The `input` hook, split from the pi wiring so it can be tested against a temp
 * directory and a stub env.
 */
export async function transformInput(
	text: string,
	images: readonly InlineImage[] | undefined,
	ctx: { cwd: string; model: ExtensionContext["model"] },
	env: AttachEnv = createAttachEnv(ctx.cwd),
): Promise<InputEventResult> {
	if (!modelAcceptsImages(ctx.model)) return { action: "continue" };
	const attached = await attachImageReferences(text, env, images?.length ?? 0);
	if (attached.attached === 0) return { action: "continue" };
	return { action: "transform", text: attached.text, images: [...(images ?? []), ...attached.images] };
}

export default function pasteImageExtension(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		try {
			return await transformInput(event.text, event.images, { cwd: ctx.cwd, model: ctx.model });
		} catch {
			// Attachment is best-effort: a failure here must not block the prompt.
			return { action: "continue" };
		}
	});
}
